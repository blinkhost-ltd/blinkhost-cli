import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsVaultCommand, windowsVaultProbe } from '../windows-vault-command.js';
import { credentialProbe } from '../credential-process.js';
import { CliError } from '../errors.js';

const token = `bhr_${'synthetic_value_'.repeat(3)}`;
const failsWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof CliError);
  assert.equal(error.code, code);
  assert.ok(!String(error).includes(token));
  return true;
};

test('Windows availability allows bounded startup without accessing credentials', () => {
  const request = windowsVaultProbe();
  assert.equal(request.timeoutMs, 15_000);
  assert.equal(request.command, 'powershell.exe');
  assert.deepEqual(request.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const program = request.args.at(-1)!;
  assert.ok(program.includes("$ErrorActionPreference='Stop'"));
  assert.ok(program.endsWith('catch{exit 3}'));
  assert.ok(!/Retrieve|Remove|Add\(|ReadToEnd|New-Object|Write/.test(program));
  assert.ok(!('input' in request));
});

test('Windows startup budget accepts a helper completing beyond the old deadline', async () => {
  const result = await credentialProbe(process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 5500)'], windowsVaultProbe().timeoutMs);
  assert.deepEqual(result, { available: true });
});

test('Windows startup budget still terminates a stalled helper', async () => {
  const start = performance.now();
  const result = await credentialProbe(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], windowsVaultProbe().timeoutMs);
  assert.deepEqual(result, { available: false, failureCode: 'credential_store_timeout' });
  assert.ok(performance.now() - start < 25_000);
});

test('Windows writes use stdin and never remove or retrieve the prior credential', () => {
  const request = windowsVaultCommand('set', 'profile', token);
  assert.equal(request.command, 'powershell.exe');
  assert.equal(request.input, token);
  assert.ok(request.args.every(arg => !arg.includes(token)));
  const program = request.args.at(-1)!;
  assert.equal(program.split('$p.Add(').length, 2);
  assert.ok(!program.includes('.Remove('));
  assert.ok(!program.includes('.Retrieve('));
  assert.ok(program.includes("$ErrorActionPreference='Stop'"));
  assert.ok(program.endsWith('catch{exit 3}'));
  assert.ok(program.includes('\\Abhr_[A-Za-z0-9_-]{32,256}\\z'));
});

test('Windows profile metacharacters stay inside a quoted literal', () => {
  const request = windowsVaultCommand('set', `test-'quoted"\\ $value; quit`, token);
  assert.ok(request.args.at(-1)!.includes(`$u='test-''quoted"\\ $value; quit';`));
});

test('Windows missing-item handling applies only to get and delete', () => {
  for (const action of ['get', 'delete'] as const) {
    const request = windowsVaultCommand(action, 'profile');
    assert.equal(request.input, undefined);
    assert.ok(request.args.at(-1)!.includes('HResult -eq -2147023728'));
    assert.ok(request.args.at(-1)!.includes('exit 2'));
  }
  assert.ok(!windowsVaultCommand('set', 'profile', token).args.at(-1)!.includes('exit 2'));
});

test('Windows refuses invalid profiles and credentials before process creation', () => {
  for (const profile of ['', 'x\nquit', 'x\rquit', 'x\u0000', 'x\t', 'x'.repeat(129)]) {
    assert.throws(() => windowsVaultCommand('get', profile), failsWith('invalid_profile'));
  }
  for (const value of [undefined, '', 'bhr_short', `${token}\n`, `${token}\r`, `${token}\u2028`, `${token};quit`, `bhr_${'x'.repeat(257)}`]) {
    assert.throws(() => windowsVaultCommand('set', 'profile', value), failsWith('invalid_refresh_credential'));
  }
});
