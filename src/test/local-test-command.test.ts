import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CliError } from '../errors.js';
import { runLocalTestCommand, sanitizeLocalTestOutput } from '../local-test-command.js';

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'blinkhost-bounded-tests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function noLiveProcess(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (/\) [ZX] /.test(stat)) return;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Owned test process ${pid} survived cleanup`);
}

test('successful commands receive literal arguments and return sanitized bounded output', async t => {
  const cwd = await fixture(t);
  const result = await runLocalTestCommand(process.execPath, ['-e',
    "console.log(process.argv[1]); process.stdout.write('Bearer '); setTimeout(()=>process.stdout.write('private-token-canary\\n'),10); console.error('password=private-password-canary');", '$((2+2)); touch unexpected'], { cwd });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exit_code, 0);
  assert.match(result.output.stdout, /\$\(\(2\+2\)\); touch unexpected/);
  assert.match(result.output.stdout, /Bearer \[REDACTED\]/);
  assert.match(result.output.stderr, /password=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /private-(token|password)-canary/);
  assert.equal(result.captured_output_bytes, result.observed_output_bytes);
});

test('a nonzero exit retains its actual code and safe failure output', async t => {
  const cwd = await fixture(t);
  const result = await runLocalTestCommand(process.execPath,
    ['-e', "console.error('api_key=private-api-canary'); process.exit(7)"], { cwd });
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
  assert.match(result.output.stderr, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /private-api-canary/);
});

test('combined stdout/stderr quota fails rather than treating truncated output as success', async t => {
  const cwd = await fixture(t);
  const result = await runLocalTestCommand(process.execPath, ['-e',
    "process.stdout.write('x'.repeat(900)); setTimeout(()=>process.stderr.write('y'.repeat(900)),30); setInterval(()=>{},1000)"],
  { cwd, maxOutputBytes: 1024, terminationGraceMs: 100 });
  assert.equal(result.status, 'output_limit');
  assert.ok(result.observed_output_bytes > 1024);
  assert.ok(result.captured_output_bytes <= 1024);
  assert.ok(Buffer.byteLength(result.output.stdout + result.output.stderr) <= 1024);
});

test('timeout escalates past ignored SIGTERM and closes descendant-held pipes',
  { skip: process.platform !== 'linux' }, async t => {
    const cwd = await fixture(t);
    await writeFile(join(cwd, 'child.cjs'), "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)");
    const result = await runLocalTestCommand(process.execPath, ['-e',
      "const fs=require('node:fs'),{spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['child.cjs'],{stdio:'inherit'}); fs.writeFileSync('pids',process.pid+' '+child.pid); setInterval(()=>{},1000)"],
    { cwd, timeoutMs: 500, terminationGraceMs: 100 });
    assert.equal(result.status, 'timed_out');
    assert.equal(result.cleanup.scope, 'posix_process_group');
    assert.equal(result.cleanup.kill_requested, true);
    assert.ok(result.duration_ms < 3000);
    for (const pid of (await readFile(join(cwd, 'pids'), 'utf8')).split(' ').map(Number)) await noLiveProcess(pid);
  });

test('successful roots also clean up background children in their owned process group',
  { skip: process.platform !== 'linux' }, async t => {
    const cwd = await fixture(t);
    const result = await runLocalTestCommand(process.execPath, ['-e',
      "const fs=require('node:fs'),{spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('pid',String(child.pid)); process.exit(0)"], { cwd });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.cleanup.kill_requested, true);
    await noLiveProcess(Number(await readFile(join(cwd, 'pid'), 'utf8')));
  });

test('pre-cancelled commands never launch', async t => {
  const cwd = await fixture(t);
  const controller = new AbortController(); controller.abort('SIGINT');
  const result = await runLocalTestCommand(process.execPath,
    ['-e', "require('node:fs').writeFileSync('unexpected','ran')"], { cwd, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.exit_code, null);
  assert.equal(result.observed_output_bytes, 0);
  await assert.rejects(readFile(join(cwd, 'unexpected')), { code: 'ENOENT' });
});

test('cancellation stops a running command and returns a cancellation receipt', async t => {
  const cwd = await fixture(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('SIGTERM'), 200);
  t.after(() => clearTimeout(timer));
  const result = await runLocalTestCommand(process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    { cwd, signal: controller.signal, terminationGraceMs: 50 });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.duration_ms < 2000);
});

test('spawn failure is categorized without exposing OS error text or leaking an abort listener', async t => {
  const cwd = await fixture(t);
  const controller = new AbortController();
  for (let i = 0; i < 12; i++) {
    const result = await runLocalTestCommand(join(cwd, 'missing-private-canary'), [],
      { cwd, signal: controller.signal });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.exit_code, null);
    assert.doesNotMatch(JSON.stringify(result), /missing-private-canary/);
  }
});

test('invalid limits fail before launch', async t => {
  const cwd = await fixture(t);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 3_600_001 }, { timeoutMs: 1.5 },
    { maxOutputBytes: 0 }, { maxOutputBytes: 8_388_609 }, { terminationGraceMs: 5001 }]) {
    await assert.rejects(runLocalTestCommand(process.execPath, [], { cwd, ...options }),
      (error: unknown) => error instanceof CliError && error.code === 'invalid_test_limits');
  }
});

test('sanitization screens private keys, credential URLs, quoted fields and terminal controls', () => {
  const value = '\u001b[31mBearer private-bearer-canary\u001b[0m\n'
    + '"password": "private-password-canary", token=private-token-canary\n'
    + 'https://customer:private-url-canary@example.invalid/\n'
    + '-----BEGIN PRIVATE KEY-----\nprivate-key-canary\n-----END PRIVATE KEY-----\n'
    + 'safe\u0007\u202e message';
  const sanitized = sanitizeLocalTestOutput(value);
  assert.doesNotMatch(sanitized, /private-\w+-canary|\u001b|\u0007|\u202e/);
  assert.match(sanitized, /\[REDACTED PRIVATE KEY\]/);
  assert.match(sanitized, /safe message/);
});
