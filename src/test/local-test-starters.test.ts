import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { CliError, EXIT } from '../errors.js';
import { LOCAL_TEST_CONFIG, readLocalTestConfig } from '../local-test-config.js';
import { LocalTestCommandFailure } from '../local-test-command.js';
import { SUPPORTED_FRONTENDS, SUPPORTED_MODULES, type ModuleLanguage } from '../manifest.js';
import { validateProject, writeScaffoldAtomically } from '../project.js';
import { createScaffold, type ScaffoldOptions } from '../templates.js';
import { testProject, type LocalProjectCheckResult } from '../workflows.js';

async function fixture(t: TestContext, language: ModuleLanguage = 'javascript', tests = true) {
  const parent = await mkdtemp(join(tmpdir(), 'blinkhost-test-starters-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'application');
  const scaffold = createScaffold({ name: 'application', framework: 'html', packageManager: 'npm',
    modules: [{ name: 'api', language }], tests });
  await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
  return { root, parent, scaffold };
}

async function configure(root: string, rows: unknown[]) {
  await writeFile(join(root, LOCAL_TEST_CONFIG), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks: rows }));
}

const baseCheck = { id: 'unit', target: 'module:api', kind: 'test', profile: 'native' };

test('installed runner shorthand resolves CLI-owned adapters and implicit structured results', async t => {
  const { root, scaffold } = await fixture(t);
  const literal = '$(touch unexpected) `touch unexpected`';
  await configure(root, ['node', 'python-unittest', 'go', 'rust'].map((runner, index) =>
    ({ ...baseCheck, id: 'unit-' + index, runner, args: [literal] })));
  const rows = (await readLocalTestConfig(root, scaffold.manifest))!;
  assert.deepEqual(rows.map(row => row.runner), ['node', 'python-unittest', 'go', 'rust']);
  for (const row of rows) {
    assert.equal(row.cwd, '_server_islands/api');
    assert.deepEqual(row.results, { format: 'blinkhost/v1' });
    assert.equal(row.args.at(-1), literal);
  }
  assert.equal(rows[0]!.command, process.execPath);
  assert.deepEqual(rows[0]!.args.slice(0, 2), ['--test',
    '--test-reporter=' + fileURLToPath(new URL('../local-test-node-reporter.js', import.meta.url))]);
  assert.equal(rows[1]!.command, 'python3');
  assert.equal(rows[1]!.args[0], '-B');
  assert.equal(rows[1]!.args[1], fileURLToPath(new URL('../../test-runners/python-unittest.py', import.meta.url)));
  for (const row of rows.slice(2)) {
    assert.equal(row.command, process.execPath);
    assert.equal(row.args[0], fileURLToPath(new URL(`../local-test-${row.runner}-runner.js`, import.meta.url)));
  }
});

for (const [name, fields] of [
  ['unknown runner', { runner: 'jest' }],
  ['runner array', { runner: ['node'] }],
  ['runner and command', { runner: 'node', command: process.execPath }],
  ['missing command and runner', {}],
  ['WASM profile', { runner: 'rust', profile: 'wasm' }],
  ['browser profile', { runner: 'node', profile: 'browser' }],
  ['unspecified profile', { runner: 'go', profile: 'unspecified' }],
  ['integration kind', { runner: 'python-unittest', kind: 'integration' }],
  ['build kind', { runner: 'node', kind: 'build' }],
  ['invalid explicit result format', { runner: 'rust', results: { format: 'junit' } }],
] as const) {
  test(`installed runner configuration rejects ${name}`, async t => {
    const { root, scaffold } = await fixture(t);
    await configure(root, [{ ...baseCheck, ...fields }]);
    await assert.rejects(readLocalTestConfig(root, scaffold.manifest),
      (error: unknown) => error instanceof CliError && error.code === 'invalid_local_test_config');
  });
}

test('Node shorthand rejects argument changes to reporter and execution mode before any check runs', async t => {
  const { root, scaffold } = await fixture(t);
  for (const args of [
    ['--test-reporter=tap'], ['--test-reporter', 'tap'], ['--test-reporter-destination=output.txt'],
    ['--test-isolation=none'], ['--test-watch'], ['--watch'], ['--watch-path=.'], ['--test-only'],
    ['--eval=process.exit(0)'], ['-e', 'process.exit(0)'], ['--input-type=module'], ['--print=0'], ['-p', '0'],
  ]) {
    await configure(root, [{ ...baseCheck, runner: 'node', args }]);
    await assert.rejects(readLocalTestConfig(root, scaffold.manifest),
      (error: unknown) => error instanceof CliError && error.code === 'invalid_local_test_config', args.join(' '));
  }
});

for (const language of SUPPORTED_MODULES) {
  test(`${language} generated application tests execute actual shared logic and catch a regression`, { timeout: 90_000 }, async t => {
    const { root } = await fixture(t, language);
    assert.deepEqual((await validateProject(root)).errors, []);
    const result = await testProject([root, '--timeout', '60']);
    assert.equal(result.status, 'tests_passed');
    assert.equal(result.tests_executed, 2);
    assert.deepEqual(result.test_counts, { total: 2, passed: 2, failed: 0, skipped: 0, unsupported: 0 });
    assert.equal(result.test_evidence, 'customer_runner_reported');
    assert.equal(result.backend_modules[0]!.status, 'tests_passed');
    assert.equal(result.checks[0]!.profile, 'native');
    assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
    if (language === 'python') {
      const module = join(root, '_server_islands/api');
      const validate = "import pathlib; files = list(pathlib.Path('.').rglob('*.py')); assert files; [compile(p.read_bytes(), str(p), 'exec') for p in files]";
      const validated = spawnSync('python3', ['-B', '-c', validate], { cwd: module, encoding: 'utf8', timeout: 10_000 });
      assert.equal(validated.status, 0, validated.stdout + validated.stderr);
      await assert.rejects(access(join(root, '_server_islands/api/__pycache__')));
    }
    const entry = language === 'rust' ? 'src/application.rs'
      : language === 'go' ? 'application/response.go'
      : language === 'python' ? 'application.py'
      : language === 'typescript' ? 'index.ts' : 'index.js';
    const path = join(root, '_server_islands/api', entry);
    const source = await readFile(path, 'utf8');
    const mutated = source.replace(language === 'python' ? 'True' : 'true', language === 'python' ? 'False' : 'false');
    assert.notEqual(source, mutated);
    await writeFile(path, mutated);
    await assert.rejects(testProject([root, '--timeout', '60']), (error: unknown) => {
      assert.ok(error instanceof LocalTestCommandFailure);
      assert.equal(error.code, 'project_test_failed');
      const checks = error.projectChecks as LocalProjectCheckResult;
      assert.equal(checks.backend_modules[0]!.status, 'failed');
      const report = checks.checks[0]!.report!;
      assert.ok(report.counts.failed >= 1);
      assert.equal(report.counts.passed + report.counts.failed, 2);
      assert.equal(report.profile, 'native');
      return true;
    });
  });
}

test('multi-module native starters retain every module and exact individual test counts', { timeout: 90_000 }, async t => {
  const { root } = await fixture(t);
  const scaffold = createScaffold({ name: 'application', framework: 'html', packageManager: 'npm', tests: true,
    modules: SUPPORTED_MODULES.map(language => ({ name: 'api-' + language, language })) });
  await rm(root, { recursive: true });
  await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
  const result = await testProject([root, '--timeout', '60']);
  assert.equal(result.tests_executed, 10);
  assert.equal(result.checks.length, 5);
  assert.ok(result.backend_modules.every(row => row.status === 'tests_passed'));
  assert.deepEqual(result.checks.map(row => row.target), SUPPORTED_MODULES.map(language => 'module:api-' + language));
});

test('test starters are opt-in and a separate frontend build does not invent frontend tests', () => {
  for (const framework of SUPPORTED_FRONTENDS) {
    const options: ScaffoldOptions = { name: 'application', framework, packageManager: 'npm',
      modules: SUPPORTED_MODULES.map(language => ({ name: language, language })) };
    const original = createScaffold(options);
    assert.deepEqual([...createScaffold({ ...options, tests: false }).files], [...original.files]);
    assert.equal(original.files.has(LOCAL_TEST_CONFIG), false);
    assert.equal(original.files.has('TESTING.md'), false);
    const scaffold = createScaffold({ ...options, tests: true });
    const config = JSON.parse(scaffold.files.get(LOCAL_TEST_CONFIG)!);
    const builds = config.checks.filter((row: { kind: string }) => row.kind === 'build');
    assert.equal(config.checks.length, framework === 'html' ? 5 : 6);
    assert.equal(builds.length, framework === 'html' ? 0 : 1);
    if (builds.length) assert.deepEqual(builds[0], { id: 'frontend-build', target: 'frontend', command: 'npm',
      args: ['run', 'build'], kind: 'build', profile: 'unspecified' });
    assert.deepEqual(scaffold.manifest, original.manifest);
    assert.match(scaffold.files.get('README.md')!, /TESTING.md/);
    assert.match(scaffold.files.get('TESTING.md')!, /Native results do not certify host calls, compiled WASM, libSQL/);
  }
});

test('starters enforce nonempty modules and the 32-check bound including frontend builds', () => {
  const options: ScaffoldOptions = { name: 'application', framework: 'html', packageManager: 'npm', modules: [], tests: true };
  assert.throws(() => createScaffold(options), (error: unknown) => error instanceof CliError && error.code === 'missing_test_module');
  options.modules = Array.from({ length: 32 }, (_, index) => ({ name: 'api-' + index, language: 'javascript' }));
  assert.equal(JSON.parse(createScaffold(options).files.get(LOCAL_TEST_CONFIG)!).checks.length, 32);
  assert.throws(() => createScaffold({ ...options, framework: 'react' }),
    (error: unknown) => error instanceof CliError && error.code === 'too_many_test_checks');
  assert.throws(() => createScaffold({ ...options, modules: [...options.modules, { name: 'more', language: 'python' }] }),
    (error: unknown) => error instanceof CliError && error.code === 'too_many_test_checks');
});

test('maximum-length module names still generate bounded, distinct check IDs', async t => {
  const { root } = await fixture(t);
  const scaffold = createScaffold({ name: 'application', framework: 'html', packageManager: 'npm', tests: true,
    modules: [{ name: 'a'.repeat(64), language: 'python' }, { name: 'a'.repeat(63) + 'b', language: 'python' },
      { name: 'native-1', language: 'python' }] });
  await rm(root, { recursive: true });
  await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
  const checks = (await readLocalTestConfig(root, scaffold.manifest))!;
  assert.equal(new Set(checks.map(row => row.id)).size, 3);
  assert.ok(checks.every(row => row.id.length <= 64));
});

test('create --tests --no-install generates runnable native tests without application CLI dependencies', async t => {
  const { parent } = await fixture(t);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'create', 'customer-app', '--template', 'html',
    '--module', 'api:javascript', '--tests', '--no-install', '--json'], { cwd: parent, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.data.installed, false);
  assert.equal(receipt.data.modules, 1);
  assert.ok(receipt.data.generated_files.includes(LOCAL_TEST_CONFIG));
  const root = join(parent, 'customer-app');
  await assert.rejects(access(join(root, 'node_modules')));
  assert.doesNotMatch(await readFile(join(root, '_server_islands/api/package.json'), 'utf8'), /@blinkhost\/cli/);
  const tested = spawnSync(process.execPath, [cli, 'test', root, '--json'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(tested.status, 0, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).data.tests_executed, 2);
  assert.equal(tested.stderr, '');
});

test('invalid --tests creation leaves no partial destination', async t => {
  const { parent } = await fixture(t);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  for (const extra of [[], Array.from({ length: 33 }, (_, index) => ['--module', `api-${index}:javascript`]).flat()]) {
    const result = spawnSync(process.execPath, [cli, 'create', 'invalid-app', '--template', 'html',
      '--tests', '--no-install', '--json', ...extra], { cwd: parent, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, EXIT.usage);
    assert.equal(JSON.parse(result.stdout).error.code, extra.length ? 'too_many_test_checks' : 'missing_test_module');
    await assert.rejects(access(join(parent, 'invalid-app')));
  }
});
