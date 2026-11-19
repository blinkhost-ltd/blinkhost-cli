import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CliError, EXIT } from '../errors.js';
import { writeScaffoldAtomically } from '../project.js';
import { createScaffold } from '../templates.js';
import { supportedNodeVersion } from '../version.js';
import { localProjectCheckMessage, testProject } from '../workflows.js';

async function fixture(t: TestContext, options: {
  html?: boolean; hasTest?: boolean; failing?: boolean; modules?: boolean; nested?: boolean;
} = {}): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'blinkhost-local-checks-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'project');
  const scaffold = createScaffold({ name: 'checks', framework: options.html ? 'html' : 'react',
    packageManager: 'npm', modules: options.modules ? [
      { name: 'api', language: 'rust' }, { name: 'worker', language: 'python' },
    ] : [] });
  if (!options.html) {
    const scripts = options.hasTest
      ? { test: 'node checks.cjs', build: 'node build.cjs' }
      : { build: 'node checks.cjs' };
    scaffold.files.set('package.json', JSON.stringify({ name: 'checks', private: true, scripts }));
    scaffold.files.set('checks.cjs', `console.log('synthetic child output'); process.exit(${options.failing ? 7 : 0});`);
    scaffold.files.set('build.cjs', "require('node:fs').writeFileSync('build-ran', 'unexpected');");
  }
  if (options.nested) {
    scaffold.manifest.frontend.root = 'apps/web';
    scaffold.manifest.frontend.dependency_root = 'apps/web';
    const original = [...scaffold.files];
    scaffold.files.clear();
    for (const [path, content] of original) scaffold.files.set(
      path.startsWith('_server_islands/') ? path : `apps/web/${path}`, content);
  }
  await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
  return root;
}

test('static structure validation reports zero executed tests and untested modules', async t => {
  const root = await fixture(t, { html: true, modules: true });
  const result = await testProject([root], true);
  assert.equal(result.schema, 'blinkhost.local-project-checks/v1');
  assert.equal(result.status, 'validation_only');
  assert.equal(result.tests_executed, 0);
  assert.equal(result.test_evidence, 'not_run');
  assert.equal(result.command, undefined);
  assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
  assert.deepEqual(result.backend_modules.map(row => [row.name, row.language, row.status]), [
    ['api', 'rust', 'not_run'], ['worker', 'python', 'not_run'],
  ]);
  assert.match(localProjectCheckMessage(result), /No tests ran/);
  assert.match(localProjectCheckMessage(result), /2 backend module\(s\) were not tested/);
});

test('successful fallback build cannot claim tests or collected coverage', async t => {
  const root = await fixture(t);
  const result = await testProject([root], true);
  assert.equal(result.status, 'build_only');
  assert.equal(result.command, 'npm run build');
  assert.equal(result.exit_code, 0);
  assert.equal(result.tests_executed, 0);
  assert.equal(result.test_evidence, 'not_run');
  assert.match(localProjectCheckMessage(result), /build completed.*No tests ran/);
});

test('frontend command success keeps counts unknown and does not run backend modules or fallback build', async t => {
  const root = await fixture(t, { hasTest: true, modules: true, nested: true });
  const result = await testProject([root], true);
  assert.equal(result.status, 'test_command_succeeded');
  assert.equal(result.command, 'npm run test');
  assert.equal(result.test_evidence, 'command_exit_only');
  assert.equal(result.tests_executed, null);
  assert.equal(result.backend_modules.length, 2);
  assert.ok(result.backend_modules.every(row => row.status === 'not_run'));
  assert.match(localProjectCheckMessage(result), /Test counts and coverage were not collected/);
  await assert.rejects(access(join(root, 'apps/web/build-ran')));
});

for (const hasTest of [false, true]) {
  test(`failed ${hasTest ? 'test' : 'build'} command preserves nonzero validation result`, async t => {
    const root = await fixture(t, { hasTest, failing: true });
    await assert.rejects(testProject([root], true), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, EXIT.validation);
      assert.equal(error.code, 'project_test_failed');
      assert.match(error.message, /exited with code 7/);
      return true;
    });
  });
}

test('invalid declared module fails validation before frontend command runs', async t => {
  const root = await fixture(t, { hasTest: true, modules: true });
  const manifest = await readFile(join(root, 'blinkhost.yaml'), 'utf8');
  await writeFile(join(root, 'blinkhost.yaml'), manifest.replace(
    'path: _server_islands/api', 'path: _server_islands/missing'));
  await assert.rejects(testProject([root], true), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'project_invalid');
    return true;
  });
});

test('CLI JSON response reports build-only outcome without mixing subprocess stdout',
  { skip: !supportedNodeVersion() }, async t => {
    const root = await fixture(t);
    const cli = join(process.cwd(), 'dist/cli.js');
    const result = spawnSync(process.execPath, [cli, 'test', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, EXIT.success);
    const response = JSON.parse(result.stdout);
    assert.equal(response.data.status, 'build_only');
    assert.equal(response.data.tests_executed, 0);
    assert.match(response.message, /No tests ran/);
    assert.match(response.data.execution.output.stdout, /synthetic child output/);
    assert.equal(result.stderr, '');
  });

test('CLI output-limit failures retain a sanitized execution receipt and nonzero exit',
  { skip: !supportedNodeVersion() }, async t => {
    const root = await fixture(t, { hasTest: true });
    await writeFile(join(root, 'checks.cjs'), "process.stdout.write('x'.repeat(2000)); setInterval(()=>{},1000)");
    const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/cli.js'),
      'test', root, '--max-output-bytes', '1024', '--json'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, EXIT.validation);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'project_test_output_limit');
    assert.equal(response.error.execution.status, 'output_limit');
    assert.ok(response.error.execution.captured_output_bytes <= 1024);
    assert.equal(result.stderr, '');
  });

test('invalid CLI limits reject before project or command execution', async () => {
  for (const value of ['0', '3601', '1.5', '-1', 'NaN']) {
    await assert.rejects(testProject(['--timeout', value], true),
      (error: unknown) => error instanceof CliError && error.code === 'invalid_test_limits');
  }
  await assert.rejects(testProject(['--max-output-bytes', '8388609'], true),
    (error: unknown) => error instanceof CliError && error.code === 'invalid_test_limits');
});

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`CLI ${signal} cancels its owned command and returns ${expectedCode} with one JSON response`,
    { skip: !supportedNodeVersion() || process.platform !== 'linux' }, async t => {
      const root = await fixture(t, { hasTest: true });
      await writeFile(join(root, 'checks.cjs'),
        "require('node:fs').writeFileSync('ready',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)");
      const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'test', root, '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      const done = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local CLI cancellation exceeded six seconds')); }, 6000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      let pid: number | undefined;
      for (let i = 0; i < 150; i++) {
        try { pid = Number(await readFile(join(root, 'ready'), 'utf8')); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(pid, 'Test command never became ready');
      t.after(() => { try { process.kill(pid!, 'SIGKILL'); } catch { /* Owned fixture already exited. */ } });
      child.kill(signal);
      assert.equal(await done, expectedCode);
      const response = JSON.parse(output);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'project_test_cancelled');
      assert.equal(response.error.execution.status, 'cancelled');
      assert.equal(errors, '');
    });
}

for (const scenario of ['success_stalled', 'failure_stalled', 'interrupt_stalled', 'closed_pipe'] as const) {
  test(`CLI bounds result delivery for ${scenario}`,
    { skip: !supportedNodeVersion() || process.platform !== 'linux' }, async t => {
      const root = await fixture(t, { hasTest: true });
      await writeFile(join(root, 'checks.cjs'),
        `process.stdout.write('x'.repeat(500000)); process.exitCode=${scenario === 'failure_stalled' ? 7 : 0};`);
      const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'test', root, '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.resume();
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy();
      });
      if (scenario === 'closed_pipe') child.stdout.destroy();
      else if (scenario === 'interrupt_stalled') child.stdout.once('readable', () => { child.kill('SIGINT'); });
      const done = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local result delivery exceeded six seconds')); }, 6000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        // An unread pipe can delay close after process exit; assert the actual process bound.
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(await done, scenario === 'interrupt_stalled' ? 130 : EXIT.filesystem);
    });
}
