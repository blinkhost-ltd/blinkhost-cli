import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CliError } from '../errors.js';
import { LOCAL_TEST_CONFIG, readLocalTestConfig } from '../local-test-config.js';
import { LocalTestChecksFailure, LocalTestCommandFailure } from '../local-test-command.js';
import { LOCAL_TEST_GATE_CONFIG, LOCAL_TEST_GATE_LIMITS, captureLocalTestGateConfiguration,
  prepareLocalTestGate, finishLocalTestGate } from '../local-test-gates.js';
import { validateProject, writeScaffoldAtomically } from '../project.js';
import { createScaffold } from '../templates.js';
import { localProjectCheckMessage, testProject, type LocalProjectCheckResult } from '../workflows.js';

const limits = { timeout_ms: 30_000, max_output_bytes: 1024 * 1024 };
const categories = ['source', 'artifacts', 'dependencies', 'runtime', 'resources', 'fixtures'] as const;
function policy(): { schema: string; inputs: Record<string, string[]>; stages: Record<string, string[]> } {
  return { schema: 'blinkhost.local-test-gates/v1', inputs: {
    source: ['app.test.cjs'], artifacts: ['app.wasm'], dependencies: ['dependencies.json'],
    runtime: ['runtime.json'], resources: ['resources.json'], fixtures: ['fixtures.json'],
  }, stages: { preview: ['unit'], promotion: ['unit'] } };
}
const passingTest = "const test=require('node:test'); const assert=require('node:assert/strict'); test('customer assertion',()=>assert.equal(2+2,4));";
const nodeCheck = (id = 'unit', args = ['app.test.cjs']) => ({ id, target: 'project', runner: 'node',
  args, kind: 'test', profile: 'native' });
async function configure(root: string, checks: unknown[] = [nodeCheck()], gates: unknown = policy()): Promise<void> {
  await writeFile(join(root, LOCAL_TEST_CONFIG), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks }));
  await writeFile(join(root, LOCAL_TEST_GATE_CONFIG), JSON.stringify(gates));
}
async function fixture(t: TestContext): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'blinkhost-local-gates-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'project');
  const scaffold = createScaffold({ name: 'gate-checks', framework: 'html', packageManager: 'npm', modules: [] });
  await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
  for (const filename of Object.values(policy().inputs).flat()) await writeFile(join(root, filename), filename === 'app.test.cjs' ? passingTest : '{}');
  await configure(root);
  return root;
}
function code(value: string): (error: unknown) => boolean { return error => error instanceof CliError && error.code === value; }
function receipt(error: unknown): NonNullable<LocalProjectCheckResult['local_gate']> {
  assert.ok(error instanceof LocalTestChecksFailure || error instanceof LocalTestCommandFailure);
  const gate = (error.projectChecks as LocalProjectCheckResult).local_gate;
  assert.ok(gate); assert.equal(gate.production_authority, false); assert.equal(gate.status, 'blocked');
  return gate;
}
async function prepare(root: string) {
  const manifest = (await validateProject(root)).manifest;
  const definitions = await readLocalTestConfig(root, manifest);
  assert.ok(definitions);
  return prepareLocalTestGate(root, 'preview', definitions, limits, performance.now() + limits.timeout_ms);
}

test('actual customer Node tests pass a declared-input gate without granting production authority', async t => {
  const root = await fixture(t);
  const result = await testProject([root, '--gate', 'preview']);
  assert.equal(result.status, 'tests_passed');
  const gate = result.local_gate!;
  assert.equal(gate.status, 'passed'); assert.equal(gate.stage, 'preview');
  assert.equal(gate.authority, 'customer_runner_reported'); assert.equal(gate.scope, 'declared_local_inputs');
  assert.equal(gate.production_authority, false); assert.equal(gate.inputs_unchanged, true);
  assert.equal(gate.input_sha256, gate.observed_input_sha256);
  assert.ok(categories.every(category => gate.inputs.some(input => input.category === category)));
  assert.ok(['blinkhost.yaml', LOCAL_TEST_CONFIG, LOCAL_TEST_GATE_CONFIG].every(path => gate.inputs.some(input => input.path === path)));
  assert.ok(gate.inputs.some(input => input.category === 'cli'));
  assert.deepEqual(gate.checks, [{ id: 'unit', status: 'passed', reason: null }]);
  assert.match(localProjectCheckMessage(result), /preview local gate passed/);
  assert.doesNotMatch(JSON.stringify(gate), /customer assertion|2\+2|run_id|result_path|production_authority":true/);
});

for (const [name, source, errorCode] of [
  ['failed assertion', "const test=require('node:test'); test('failed',()=>{throw new Error('expected fixture failure')});", 'project_test_failed'],
  ['only skipped tests', "require('node:test')('skipped',{skip:true},()=>{});", 'local_test_gate_blocked'],
  ['passed and skipped tests', passingTest + "test('skipped',{skip:true},()=>{});", 'local_test_gate_blocked'],
  ['no discovered tests', "// deliberately no customer tests", 'local_test_gate_blocked'],
] as const) {
  test(`gate blocks ${name} with real runner evidence`, async t => {
    const root = await fixture(t); await writeFile(join(root, 'app.test.cjs'), source);
    await assert.rejects(testProject([root, '--gate', 'preview']), error => {
      assert.ok(code(errorCode)(error));
      const gate = receipt(error); assert.equal(gate.checks[0]!.status, 'blocked');
      return true;
    });
  });
}

test('preview and promotion apply their selected required checks and ungated runs retain honest skips', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'integration.cjs'), "require('node:test')('integration not available',{skip:true},()=>{});");
  const gates = policy(); gates.inputs.source!.push('integration.cjs'); gates.stages.promotion = ['unit', 'integration'];
  await configure(root, [nodeCheck(), nodeCheck('integration', ['integration.cjs'])], gates);
  const preview = await testProject([root, '--gate', 'preview']);
  assert.equal(preview.local_gate!.status, 'passed'); assert.equal(preview.test_counts!.skipped, 1);
  await assert.rejects(testProject([root, '--gate', 'promotion']), error => {
    const gate = receipt(error);
    assert.deepEqual(gate.checks.map(check => check.status), ['passed', 'blocked']); return true;
  });
  const ungated = await testProject([root]);
  assert.equal(ungated.local_gate, undefined); assert.equal(ungated.test_counts!.skipped, 1);
});

const reportedCommand = (body: string, extra: Record<string, unknown> = {}) => ({ id: 'unit', target: 'project',
  command: process.execPath, args: ['-e', body], kind: 'test', profile: 'native', results: { format: 'blinkhost/v1' }, ...extra });
const report = (status = 'passed') => "const fs=require('node:fs'),env=process.env; fs.writeFileSync(env.BLINKHOST_TEST_RESULT_PATH,JSON.stringify({schema:'blinkhost.local-test-results/v1',run_id:env.BLINKHOST_TEST_RUN_ID,check_id:env.BLINKHOST_TEST_CHECK_ID,profile:env.BLINKHOST_TEST_PROFILE,runner:'customer-fixture/1',tests:[{id:'assertion',name:'fixture assertion',status:'" + status + "'}]}));";

for (const [name, command, errorCode] of [
  ['missing report', 'process.exit(0)', 'missing_local_test_results'],
  ['invalid report', "require('node:fs').writeFileSync(process.env.BLINKHOST_TEST_RESULT_PATH,'{}')", 'invalid_local_test_results'],
  ['unsupported tests', report('unsupported'), 'local_test_gate_blocked'],
  ['nonzero exit despite passing report', report() + 'process.exit(7)', 'project_test_failed'],
] as const) {
  test(`gate blocks ${name}`, async t => {
    const root = await fixture(t); await configure(root, [reportedCommand(command)]);
    await assert.rejects(testProject([root, '--gate', 'preview']), error => {
      assert.ok(code(errorCode)(error)); assert.equal(receipt(error).checks[0]!.status, 'blocked'); return true;
    });
  });
}

for (const category of [...categories, 'configuration'] as const) {
  test(`gate rejects changed ${category} after passing actual tests`, async t => {
    const root = await fixture(t);
    const path = category === 'configuration' ? 'blinkhost.yaml' : policy().inputs[category]![0]!;
    await writeFile(join(root, 'app.test.cjs'), passingTest + "require('node:fs').appendFileSync(" + JSON.stringify(path) + ",' changed');");
    await assert.rejects(testProject([root, '--gate', 'preview']), error => {
      assert.ok(code('local_test_gate_blocked')(error));
      const gate = receipt(error); assert.equal(gate.reason, 'declared_inputs_changed');
      assert.equal(gate.inputs_unchanged, false); assert.notEqual(gate.observed_input_sha256, gate.input_sha256);
      assert.equal(gate.checks[0]!.status, 'passed'); return true;
    });
  });
}

test('gate rejects a deleted declared input after passing tests', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.test.cjs'), passingTest + "require('node:fs').unlinkSync('resources.json');");
  await assert.rejects(testProject([root, '--gate', 'preview']), error => {
    assert.equal(receipt(error).reason, 'declared_inputs_unavailable'); return true;
  });
});

for (const [name, mutate] of [
  ['unknown stage', (p: ReturnType<typeof policy>) => { p.stages.production = ['unit']; }],
  ['missing selected stage', (p: ReturnType<typeof policy>) => { delete p.stages.preview; }],
  ['empty selected checks', (p: ReturnType<typeof policy>) => { p.stages.preview = []; }],
  ['duplicate check IDs', (p: ReturnType<typeof policy>) => { p.stages.preview = ['unit', 'unit']; }],
  ['missing required check', (p: ReturnType<typeof policy>) => { p.stages.promotion = ['unknown']; }],
  ['missing input category', (p: ReturnType<typeof policy>) => { delete p.inputs.fixtures; }],
  ['empty source', (p: ReturnType<typeof policy>) => { p.inputs.source = []; }],
  ['unknown input category', (p: ReturnType<typeof policy>) => { p.inputs.secrets = []; }],
  ['duplicate input path', (p: ReturnType<typeof policy>) => { p.inputs.runtime = ['app.wasm']; }],
  ['path escape', (p: ReturnType<typeof policy>) => { p.inputs.source = ['../outside']; }],
  ['absolute path', (p: ReturnType<typeof policy>) => { p.inputs.source = ['/etc/hosts']; }],
  ['noncanonical path', (p: ReturnType<typeof policy>) => { p.inputs.source = ['./app.test.cjs']; }],
  ['too many paths', (p: ReturnType<typeof policy>) => { p.inputs.source = Array(LOCAL_TEST_GATE_LIMITS.files + 1).fill('app.test.cjs'); }],
] as const) {
  test(`gate preflight rejects ${name} before any command runs`, async t => {
    const root = await fixture(t); const gates = policy(); mutate(gates);
    await configure(root, [reportedCommand("require('node:fs').writeFileSync('unexpected','yes');" + report())], gates);
    await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
    await assert.rejects(access(join(root, 'unexpected')));
  });
}

test('missing structured evidence, build-only checks and unavailable executables fail before commands run', async t => {
  const root = await fixture(t);
  for (const extra of [{ results: undefined }, { results: undefined, kind: 'build' }, { command: 'blinkhost-gate-fixture-missing-executable' }]) {
    await configure(root, [reportedCommand("require('node:fs').writeFileSync('unexpected','yes');" + report(), extra)]);
    await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  }
  await assert.rejects(access(join(root, 'unexpected')));
});

test('duplicate JSON keys including escaped keys and malformed policy bytes are rejected', async t => {
  const root = await fixture(t);
  const valid = JSON.stringify(policy());
  const values: Array<string | Buffer> = [
    valid.replace('"preview":["unit"]', '"preview":["missing"],"preview":["unit"]'),
    valid.replace('"preview":["unit"]', '"pre\\u0076iew":["missing"],"preview":["unit"]'),
    valid.replace('"source":["app.test.cjs"]', '"source":[],"source":["app.test.cjs"]'),
    '{"schema":', Buffer.from([0xff, 0xfe]), ' '.repeat(65_537),
  ];
  for (const value of values) {
    await writeFile(join(root, LOCAL_TEST_GATE_CONFIG), value);
    await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  }
});

test('symlinks, directories and special files cannot be hashed as declared input files', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'owned'));
  await writeFile(join(root, 'owned/source.cjs'), passingTest);
  await symlink('owned', join(root, 'linked-directory'));
  await symlink('owned/source.cjs', join(root, 'linked-file.cjs'));
  assert.equal(spawnSync('mkfifo', [join(root, 'owned/pipe')]).status, 0);
  for (const path of ['linked-file.cjs', 'linked-directory/source.cjs', 'owned', 'owned/pipe']) {
    const gates = policy(); gates.inputs.source = [path]; await configure(root, [nodeCheck()], gates);
    await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  }
});

test('configuration observed before parsing cannot be replaced before gate preparation', async t => {
  const root = await fixture(t);
  const deadline = performance.now() + limits.timeout_ms;
  const configuration = await captureLocalTestGateConfiguration(root, deadline);
  const manifest = (await validateProject(root)).manifest;
  const checks = (await readLocalTestConfig(root, manifest))!;
  await configure(root, [nodeCheck('replacement')]);
  await assert.rejects(prepareLocalTestGate(root, 'preview', checks, limits, deadline, undefined, configuration), code('invalid_local_test_gate'));
});

test('source and execution limits are part of distinct before-run identities', async t => {
  const root = await fixture(t); const first = await prepare(root);
  await writeFile(join(root, 'resources.json'), '{"profile":"changed"}');
  const second = await prepare(root); assert.notEqual(first.digest, second.digest);
  const checks = (await readLocalTestConfig(root, (await validateProject(root)).manifest))!;
  const third = await prepareLocalTestGate(root, 'preview', checks, { ...limits, max_output_bytes: 2048 }, performance.now() + limits.timeout_ms);
  assert.notEqual(second.digest, third.digest);
});

test('changed executable resolution and changed executable bytes block stale tool identity', async t => {
  const root = await fixture(t);
  for (const filename of ['first-tool', 'second-tool']) {
    await writeFile(join(root, filename), '#!/bin/sh\nexit 0\n'); await chmod(join(root, filename), 0o700);
  }
  await symlink('first-tool', join(root, 'selected-tool'));
  await configure(root, [reportedCommand(report(), { command: './selected-tool', args: [] })]);
  const before = await prepare(root);
  await rm(join(root, 'selected-tool')); await symlink('second-tool', join(root, 'selected-tool'));
  const changedResolution = await finishLocalTestGate(before, [], performance.now() + limits.timeout_ms);
  assert.equal(changedResolution.status, 'blocked'); assert.equal(changedResolution.reason, 'declared_inputs_unavailable');
  const after = await prepare(root); await writeFile(join(root, 'second-tool'), '#!/bin/sh\nexit 1\n');
  const changedBytes = await finishLocalTestGate(after, [], performance.now() + limits.timeout_ms);
  assert.equal(changedBytes.reason, 'declared_inputs_changed'); assert.equal(changedBytes.inputs_unchanged, false);
});

test('shared snapshot budget observes cancellation and timeouts before and after commands', async t => {
  const root = await fixture(t); const before = await prepare(root);
  const controller = new AbortController(); controller.abort('SIGTERM');
  await assert.rejects(testProject([root, '--gate', 'preview'], false, controller.signal), error =>
    error instanceof CliError && error.code === 'project_test_cancelled' && error.exitCode === 143);
  const cancelled = await finishLocalTestGate(before, [], performance.now() + limits.timeout_ms, controller.signal);
  assert.equal(cancelled.reason, 'project_test_cancelled'); assert.equal(cancelled.status, 'blocked');
  const expired = await finishLocalTestGate(before, [], performance.now() - 1);
  assert.equal(expired.reason, 'project_test_timeout'); assert.equal(expired.status, 'blocked');
  await assert.rejects(captureLocalTestGateConfiguration(root, performance.now() - 1), code('project_test_timeout'));
});

test('cancellation stops the active owned process and retains a blocked gate with trailing checks unrun', async t => {
  const root = await fixture(t);
  await configure(root, [reportedCommand("require('node:fs').writeFileSync('active-marker',String(process.pid));setInterval(()=>{},1000);"), nodeCheck('pending')]);
  const controller = new AbortController();
  const promise = testProject([root, '--gate', 'preview'], false, controller.signal);
  const failure = assert.rejects(promise, error => {
    assert.ok(error instanceof LocalTestCommandFailure); assert.equal(error.code, 'project_test_cancelled');
    assert.equal(error.exitCode, 130); receipt(error);
    const result = error.projectChecks as LocalProjectCheckResult;
    assert.deepEqual(result.checks.map(check => check.status), ['cancelled', 'not_run']); return true;
  });
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await access(join(root, 'active-marker')).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const pid = Number(await readFile(join(root, 'active-marker'), 'utf8'));
  controller.abort('SIGINT'); await failure;
  assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('gate execution timeout and output overflow preserve their cause and stop trailing commands', async t => {
  const root = await fixture(t);
  for (const [body, args, expected] of [
    ['setInterval(()=>{},1000)', ['--timeout', '1'], 'project_test_timeout'],
    ["process.stdout.write('x'.repeat(2048))", ['--max-output-bytes', '1024'], 'project_test_output_limit'],
  ] as const) {
    await configure(root, [reportedCommand(body), nodeCheck('pending')]);
    await assert.rejects(testProject([root, '--gate', 'preview', ...args]), error => {
      assert.ok(code(expected)(error)); receipt(error);
      assert.equal(((error as LocalTestCommandFailure).projectChecks as LocalProjectCheckResult).checks[1]!.status, 'not_run');
      return true;
    });
  }
});

test('a prior check report cannot be replayed to pass a required gate', async t => {
  const root = await fixture(t);
  const first = reportedCommand(report() + "fs.copyFileSync(env.BLINKHOST_TEST_RESULT_PATH,'prior-result.json');");
  const second = { ...reportedCommand("require('node:fs').copyFileSync('prior-result.json',process.env.BLINKHOST_TEST_RESULT_PATH);"), id: 'replay' };
  const gates = policy(); gates.stages.preview = ['unit', 'replay'];
  await configure(root, [first, second], gates);
  await assert.rejects(testProject([root, '--gate', 'preview']), error => {
    assert.ok(code('invalid_local_test_results')(error));
    assert.deepEqual(receipt(error).checks.map(check => check.status), ['passed', 'blocked']); return true;
  });
  await access(join(root, 'prior-result.json'));
});
test('required installed Node runner output overflow blocks the gate and stops remaining checks', async t => {
  const root = await fixture(t);
  for (const stream of ['stdout', 'stderr']) {
    await writeFile(join(root, 'app.test.cjs'), "require('node:test')('bounded output',()=>process." + stream + ".write('x'.repeat(4096)));");
    await configure(root, [nodeCheck(), nodeCheck('pending')]);
    await assert.rejects(testProject([root, '--gate', 'preview', '--max-output-bytes', '1024']), error => {
      assert.ok(code('project_test_output_limit')(error));
      assert.equal(receipt(error).status, 'blocked');
      const checks = ((error as LocalTestCommandFailure).projectChecks as LocalProjectCheckResult).checks;
      assert.deepEqual(checks.map(check => check.status), ['output_limit', 'not_run']);
      assert.equal(checks[0]!.report, undefined);
      return true;
    });
  }
});

test('oversized regular files and total input bytes are bounded without reading unbounded data', async t => {
  const root = await fixture(t); const gates = policy();
  const file = await open(join(root, 'large.bin'), 'w');
  await file.truncate(LOCAL_TEST_GATE_LIMITS.fileBytes + 1); await file.close();
  gates.inputs.artifacts = ['large.bin']; await configure(root, [nodeCheck()], gates);
  await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  for (let i = 0; i < 3; i++) {
    const item = await open(join(root, `aggregate-${i}.bin`), 'w'); await item.truncate(192 * 1024 * 1024); await item.close();
  }
  gates.inputs.artifacts = ['aggregate-0.bin', 'aggregate-1.bin', 'aggregate-2.bin'];
  await configure(root, [nodeCheck()], gates);
  await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
});

test('local gates require all three configuration files and an explicit supported stage', async t => {
  const root = await fixture(t);
  await assert.rejects(testProject([root, '--gate', 'deploy']), code('invalid_local_test_gate'));
  await rm(join(root, LOCAL_TEST_GATE_CONFIG));
  await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  await configure(root); await rm(join(root, LOCAL_TEST_CONFIG));
  await assert.rejects(testProject([root, '--gate', 'preview']), code('invalid_local_test_gate'));
  const ungated = await testProject([root]); assert.equal(ungated.status, 'validation_only');
});
