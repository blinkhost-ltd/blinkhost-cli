// Destructive only to unique synthetic items on disposable GitHub-hosted runners.
// Deliberately excluded from `npm test` and the published package.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { credentialCommand } from '../dist/credential-process.js';
import { windowsVaultCommand } from '../dist/windows-vault-command.js';
import {
  credentialStoreStatus, deleteRefreshCredential, getRefreshCredential, setRefreshCredential,
} from '../dist/credentials.js';

if (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  || process.env.BLINKHOST_NATIVE_CREDENTIAL_TEST !== 'synthetic-only'
  || !process.env.RUNNER_TEMP) {
  throw new Error('Native credential tests require an explicitly enabled disposable GitHub-hosted runner.');
}

async function unlockSyntheticLinuxKeyring(control) {
  // Test-only GNOME 46.1 control protocol: unlock the existing daemon, rather
  // than starting another daemon with --unlock (which does not unlock this one).
  // Protocol reference: GNOME/gnome-keyring tag 46.1, daemon/control/
  // gkd-control-client.c and gkd-control-codes.h; Linux authenticates SO_PEERCRED
  // after a NUL byte (egg/egg-unix-credentials.c). Never shipped in the CLI.
  assert.equal(process.platform, 'linux');
  assert.equal(control, process.env.XDG_RUNTIME_DIR);
  const root = await realpath(process.env.RUNNER_TEMP);
  assert.ok((await realpath(control)).startsWith(root + '/'));
  const directory = await lstat(control);
  assert.ok(directory.isDirectory() && directory.uid === process.getuid()
    && (directory.mode & 0o077) === 0, 'test control directory is private and owned');
  const path = join(control, 'control');
  const entry = await lstat(path);
  assert.ok(entry.isSocket() && entry.uid === process.getuid(), 'test socket is owned and not a symlink');
  const password = Buffer.from('synthetic-ci-keyring-password');
  const packet = Buffer.alloc(12 + password.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt32BE(1, 4); // GKD_CONTROL_OP_UNLOCK
  packet.writeUInt32BE(password.length, 8);
  password.copy(packet, 12);
  await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = Buffer.alloc(0);
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      packet.fill(0);
      password.fill(0);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Synthetic keyring unlock timed out.')), 5000);
    socket.once('connect', () => { socket.write(Buffer.from([0])); socket.write(packet); });
    socket.once('error', () => finish(new Error('Synthetic keyring control connection failed.')));
    socket.once('end', () => finish(new Error('Synthetic keyring response was incomplete.')));
    socket.on('data', chunk => {
      if (finished) return;
      if (response.length + chunk.length > 8) return finish(new Error('Unexpected synthetic keyring response size.'));
      response = Buffer.concat([response, chunk]);
      if (response.length < 8) return;
      if (response.readUInt32BE(0) !== 8 || response.readUInt32BE(4) !== 0) {
        return finish(new Error('Synthetic keyring unlock was denied.'));
      }
      finish();
    });
  });
}

test('native vault: missing, store, read, replace, isolate, lock recovery and delete synthetic credentials', { timeout: 240_000 }, async (t) => {
  const profiles = [`ci-${randomUUID()}`, `ci-${randomUUID()}-'quoted"\\ $value; quit`];
  const tokens = [0, 1, 2].map(() => `bhr_synthetic_ci_only_${randomUUID()}`);
  let keychain;
  let keychainPassword;
  let unlock;
  let originalDefault;
  let originalSearch;
  let phase = 'setup';
  let failure;
  const security = (...args) => credentialCommand('security', args);
  const parsePaths = output => output.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  try {
    if (process.platform === 'linux') {
      // The job starts and observes one isolated daemon before this test.
      // Unlock that same daemon through its control socket, never start another.
      phase = 'initial Linux unlock';
      await unlockSyntheticLinuxKeyring(process.env.BLINKHOST_NATIVE_KEYRING_CONTROL);
    }
    if (process.platform === 'darwin') {
      // Use a fresh unlocked keychain, never the runner's existing credential items.
      originalDefault = parsePaths(await security('default-keychain', '-d', 'user'))[0];
      originalSearch = parsePaths(await security('list-keychains', '-d', 'user'));
      assert.equal(typeof originalDefault, 'string');
      assert.ok(originalSearch.length > 0);
      const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'blinkhost-ci-keychain-'));
      keychain = join(root, 'synthetic.keychain-db');
      keychainPassword = randomUUID();
      await security('create-keychain', '-p', keychainPassword, keychain);
      await security('unlock-keychain', '-p', keychainPassword, keychain);
      await security('list-keychains', '-d', 'user', '-s', keychain);
      await security('default-keychain', '-d', 'user', '-s', keychain);
    }
    phase = 'availability';
    const probeStarted = performance.now();
    const status = await credentialStoreStatus();
    t.diagnostic(`credential_probe_ms=${Math.round(performance.now() - probeStarted)}`);
    if (!status.available) {
      // Preserve only the fixed category; do not retry and hide the failed probe.
      const failureCode = ['credential_store_timeout', 'credential_store_unavailable',
        'credential_store_response_invalid', 'credential_store_failed'].find(code => code === status.failureCode);
      throw Object.assign(new Error('Credential availability probe failed.'), { code: failureCode });
    }
    for (const [index, profile] of profiles.entries()) {
      phase = index === 0 ? 'missing primary read' : 'missing quoted-profile read';
      assert.ok(await getRefreshCredential(profile) === null, 'missing credential is absent');
      phase = index === 0 ? 'missing primary delete' : 'missing quoted-profile delete';
      await deleteRefreshCredential(profile); // Absent deletion must be idempotent.
    }
    phase = 'primary store';
    await setRefreshCredential(profiles[0], tokens[0]);
    phase = 'primary readback';
    assert.ok(await getRefreshCredential(profiles[0]) === tokens[0], 'stored value round trips');
    phase = 'initial profile isolation';
    assert.ok(await getRefreshCredential(profiles[1]) === null, 'other credential remains absent');
    phase = 'quoted-profile store';
    await setRefreshCredential(profiles[1], tokens[1]);
    phase = 'primary replacement';
    await setRefreshCredential(profiles[0], tokens[2]);
    phase = 'replacement readback';
    assert.ok(await getRefreshCredential(profiles[0]) === tokens[2], 'replacement round trips');
    phase = 'quoted-profile readback';
    assert.ok(await getRefreshCredential(profiles[1]) === tokens[1], 'other profile is unchanged');
    phase = 'invalid credential rejection';
    await assert.rejects(setRefreshCredential(profiles[0], 'not-a-refresh-credential'),
      error => error.code === 'invalid_refresh_credential');
    phase = 'invalid credential preservation';
    assert.ok(await getRefreshCredential(profiles[0]) === tokens[2], 'invalid writes preserve prior value');
    if (process.platform === 'win32') {
      phase = 'Windows input transport validation';
      // Bypass only the JS builder's validation to exercise the actual fixed
      // PowerShell program on the disposable runner. This proves rejection
      // before Add, not vault-write atomicity or recovery from a native failure.
      const request = windowsVaultCommand('set', profiles[0], tokens[0]);
      for (const input of ['', `${tokens[0]}\n`, `${tokens[0]};quit`]) {
        await assert.rejects(credentialCommand(request.command, request.args, { input }), error => {
          assert.equal(error.code, 'credential_store_failed');
          assert.ok(tokens.every(token => !String(error).includes(token)));
          return true;
        });
        assert.ok(await getRefreshCredential(profiles[0]) === tokens[2], 'bad transport preserves prior value');
      }
      assert.ok(await getRefreshCredential(profiles[1]) === tokens[1], 'bad transport does not affect another profile');
      t.diagnostic('windows_input_transport_validation=denied_and_preserved');
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      phase = 'lock';
      // Only lock the isolated synthetic keychain/collection created for this job.
      // Windows Password Vault has no equivalent process-local lock operation;
      // its normal read/write/isolation checks above make no locked-vault claim.
      if (process.platform === 'darwin') {
        unlock = () => security('unlock-keychain', '-p', keychainPassword, keychain);
        await security('lock-keychain', keychain);
      } else {
        const gdbus = (path, method, ...args) => credentialCommand('gdbus', [
          'call', '--session', '--dest', 'org.freedesktop.secrets',
          '--object-path', path, '--method', method, ...args,
        ]);
        const service = '/org/freedesktop/secrets';
        const alias = await gdbus(service, 'org.freedesktop.Secret.Service.ReadAlias', 'default');
        const match = /^\(objectpath '(\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+)',\)$/.exec(alias);
        assert.ok(match, 'default collection has an explicit service path');
        const control = process.env.BLINKHOST_NATIVE_KEYRING_CONTROL;
        assert.ok(control && control === process.env.XDG_RUNTIME_DIR
          && control.startsWith(process.env.RUNNER_TEMP + '/'));
        unlock = async () => {
          await unlockSyntheticLinuxKeyring(control);
          assert.equal(await gdbus(match[1], 'org.freedesktop.DBus.Properties.Get',
            'org.freedesktop.Secret.Collection', 'Locked'), '(<false>,)', 'synthetic collection is unlocked');
        };
        await gdbus(service, 'org.freedesktop.Secret.Service.Lock', `[objectpath '${match[1]}']`);
        assert.equal(await gdbus(match[1], 'org.freedesktop.DBus.Properties.Get',
          'org.freedesktop.Secret.Collection', 'Locked'), '(<true>,)');
      }
      const started = Date.now();
      phase = 'locked read';
      await assert.rejects(getRefreshCredential(profiles[0]), error => {
        assert.ok(['credential_store_failed', 'credential_store_timeout'].includes(error.code));
        assert.ok(tokens.every(token => !String(error).includes(token)), 'error excludes stored credentials');
        return true;
      });
      assert.ok(Date.now() - started < 40_000, 'locked reads are bounded');
      t.diagnostic('locked_read=denied');
      if (process.platform === 'darwin') {
        phase = 'locked write';
        // In stdin mode an appended command could accidentally hide the failed
        // write's status. Require denial and then verify preservation on unlock.
        const writeStarted = Date.now();
        await assert.rejects(setRefreshCredential(profiles[0], tokens[0]), error => {
          assert.ok(['credential_store_failed', 'credential_store_timeout'].includes(error.code));
          assert.ok(tokens.every(token => !String(error).includes(token)));
          return true;
        });
        assert.ok(Date.now() - writeStarted < 40_000, 'locked writes are bounded');
        t.diagnostic('locked_write=denied');
      }
      phase = 'unlock';
      await unlock();
      unlock = undefined;
      phase = 'recovery';
      assert.ok(await getRefreshCredential(profiles[0]) === tokens[2], 'unlock preserves original credentials');
      assert.ok(await getRefreshCredential(profiles[1]) === tokens[1], 'unlock preserves other profiles');
      t.diagnostic('unlock_recovery=verified');
    }
    phase = 'deletion';
    await deleteRefreshCredential(profiles[0]);
    assert.ok(await getRefreshCredential(profiles[0]) === null, 'deleted credential is absent');
    assert.ok(await getRefreshCredential(profiles[1]) === tokens[1], 'delete is profile scoped');
    await deleteRefreshCredential(profiles[0]);
  } catch (error) {
    failure = error;
    // Report only static operation labels and allowlisted categories. Native
    // exceptions, stderr, tokens and profile values must not enter CI output.
    const category = ['credential_store_failed', 'credential_store_timeout',
      'credential_store_unavailable', 'credential_store_response_invalid', 'invalid_refresh_credential', 'ERR_ASSERTION']
      .find(code => code === error?.code) ?? 'unclassified';
    t.diagnostic(`native_failure_phase=${phase}; category=${category}`);
  } finally {
    // All cleanup attempts run, and any failure fails qualification.
    const errors = [];
    if (unlock) {
      try { await unlock(); } catch (error) { errors.push(error); }
    }
    for (const profile of profiles) {
      try {
        await deleteRefreshCredential(profile);
        assert.ok(await getRefreshCredential(profile) === null, 'cleanup removed synthetic credential');
      } catch (error) { errors.push(error); }
    }
    if (process.platform === 'darwin') {
      for (const args of [
        ...(originalDefault ? [['default-keychain', '-d', 'user', '-s', originalDefault]] : []),
        ...(originalSearch ? [['list-keychains', '-d', 'user', '-s', ...originalSearch]] : []),
        ...(keychain ? [['delete-keychain', keychain]] : []),
      ]) {
        try { await security(...args); } catch (error) { errors.push(error); }
      }
    }
    if (failure || errors.length) throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      `Native credential qualification failed during ${phase}; cleanup failures: ${errors.length}.`);
  }
});
