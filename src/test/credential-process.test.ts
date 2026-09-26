import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialCommand, credentialProbe } from '../credential-process.js';
import { CliError } from '../errors.js';

const execute = (source: string, options: Parameters<typeof credentialCommand>[2] = {}) =>
  credentialCommand(process.execPath, ['-e', source], options);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof CliError);
  assert.equal(error.code, expected);
  assert.ok(!JSON.stringify(error).includes('synthetic-private-value'));
  assert.ok(!error.message.includes('synthetic-private-value'));
  assert.ok(!error.message.includes('\u001b'));
  return true;
};

test('availability distinguishes missing helpers, timeouts, invalid output and service failure safely', async () => {
  assert.deepEqual(await credentialProbe(process.execPath, ['-e', 'process.exit(0)']), { available: true });
  assert.deepEqual(await credentialProbe('/synthetic-private-value/missing-helper', []),
    { available: false, failureCode: 'credential_store_unavailable' });
  assert.deepEqual(await credentialProbe(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100),
    { available: false, failureCode: 'credential_store_timeout' });
  assert.deepEqual(await credentialProbe(process.execPath, ['-e', "process.stderr.write('synthetic-private-value');process.exitCode=3"]),
    { available: false, failureCode: 'credential_store_failed' });
  assert.deepEqual(await credentialProbe(process.execPath, ['-e', "process.stdout.write('a'.repeat(16385))"]),
    { available: false, failureCode: 'credential_store_response_invalid' });
});

test('credential input uses stdin and successful output is bounded and trimmed', async () => {
  assert.equal(await execute("process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{if(process.argv.some(s=>s.includes('synthetic-private-value')))process.exit(4);process.stdout.write(input+'\\n')})",
    { input: 'synthetic-private-value' }), 'synthetic-private-value');
});

test('failed credential command never exposes stdout, stderr or terminal controls', async () => {
  await assert.rejects(execute("process.stdout.write('synthetic-private-value');process.stderr.write('\\x1b[2Jsynthetic-private-value');process.exitCode=3"), code('credential_store_failed'));
});

test('missing credential is accepted only for the exact designated exit code', async () => {
  const missing = { code: 1, requireEmptyStderr: true };
  assert.equal(await execute('process.exit(1)', { missing }), '');
  await assert.rejects(execute('process.exit(3)', { missing }), code('credential_store_failed'));
  await assert.rejects(execute('process.exit(1)'), code('credential_store_failed'));
});

test('Linux credential-service errors cannot masquerade as absent credentials', async () => {
  await assert.rejects(execute("process.stderr.write('synthetic-private-value: no session bus');process.exitCode=1",
    { missing: { code: 1, requireEmptyStderr: true } }), code('credential_store_failed'));
});

test('known macOS not-found exit may include diagnostic text without displaying it', async () => {
  assert.equal(await execute("process.stderr.write('synthetic-private-value');process.exitCode=44",
    { missing: { code: 44, requireEmptyStderr: false } }), '');
});

test('stalled subprocess is bounded and not retried', async () => {
  const start = performance.now();
  await assert.rejects(execute('setInterval(()=>{},1000)', { timeoutMs: 200 }), code('credential_store_timeout'));
  assert.ok(performance.now() - start < 5000);
});

test('stdout and stderr limits count bytes together without exposing contents', async () => {
  for (const source of ["process.stdout.write('a'.repeat(16385))", "process.stderr.write('a'.repeat(16385))",
    "process.stdout.write('a'.repeat(8192));process.stderr.write('b'.repeat(8193))",
    "process.stdout.write('é'.repeat(8193))"]) {
    await assert.rejects(execute(source), code('credential_store_response_invalid'));
  }
  assert.equal((await execute("process.stdout.write('a'.repeat(16384))")).length, 16384);
});

test('missing executable fails with a fixed diagnostic, not an OS path', async () => {
  await assert.rejects(credentialCommand('/synthetic-private-value/missing-helper', []), code('credential_store_unavailable'));
});

test('invalid deadlines are refused without running a command', async () => {
  for (const timeoutMs of [0, -1, 0.5, 30001, NaN, Infinity]) {
    await assert.rejects(execute('process.exit(0)', { timeoutMs }), code('credential_store_configuration_invalid'));
  }
});
