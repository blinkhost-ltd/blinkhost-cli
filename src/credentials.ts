import { CliError, EXIT } from './errors.js';
import { credentialCommand, credentialProbe, type CredentialProbe } from './credential-process.js';
import { macosKeychainWrite } from './macos-keychain-input.js';
import { windowsVaultCommand, windowsVaultProbe } from './windows-vault-command.js';

const SERVICE = 'blinkhost-cli';

export interface CredentialStoreStatus {
  available: boolean;
  provider: 'macos-keychain' | 'windows-password-vault' | 'linux-secret-service';
  remediation: string | null;
  failureCode?: Extract<CredentialProbe, { available: false }>['failureCode'];
}

/** Checks only whether the platform credential service can be invoked. */
export async function credentialStoreStatus(): Promise<CredentialStoreStatus> {
  if (process.platform === 'darwin') {
    const probe = await credentialProbe('security', ['help']);
    return { ...probe, provider: 'macos-keychain', remediation: probe.available ? null : 'Restore the macOS security command before interactive sign-in.' };
  }
  if (process.platform === 'win32') {
    const request = windowsVaultProbe();
    const probe = await credentialProbe(request.command, request.args, request.timeoutMs);
    return { ...probe, provider: 'windows-password-vault', remediation: probe.available ? null : 'Use Windows with PowerShell and Password Vault available.' };
  }
  // Global --version/--help are unsupported by libsecret's secret-tool (exit 2).
  // Subcommand help checks the binary without querying or unlocking any secrets.
  const probe = await credentialProbe('secret-tool', ['search', '--help']);
  return { ...probe, provider: 'linux-secret-service', remediation: probe.available ? null : 'Install libsecret tools and start an unlocked Secret Service session, or use a short-lived workload identity in headless automation.' };
}

async function run(command: string, args: string[], input?: string, acceptMissing = false): Promise<string> {
  return credentialCommand(command, args, {
    ...(input !== undefined ? { input } : {}),
    ...(acceptMissing ? { missing: {
      code: process.platform === 'darwin' ? 44 : process.platform === 'win32' ? 2 : 1,
      requireEmptyStderr: process.platform !== 'darwin',
    } } : {}),
  });
}

async function windowsCredential(action: 'get' | 'set' | 'delete', profile: string, token?: string): Promise<string> {
  const request = windowsVaultCommand(action, profile, token);
  return run(request.command, request.args, request.input, action !== 'set');
}

async function linuxCredentialExists(profile: string): Promise<boolean> {
  // lookup/clear may silently return "not found" when unlocking was cancelled.
  // Search without --unlock also sees locked items. Keep the result private and
  // bounded; a concurrent replacement must not be reported as a successful delete.
  return Boolean(await credentialCommand('secret-tool', ['search', 'service', SERVICE, 'profile', profile], {
    timeoutMs: 5000, missing: { code: 1, requireEmptyStderr: true },
  }));
}

function inaccessibleCredential(): CliError {
  return new CliError('The saved CLI credential is inaccessible or changed during this request. Unlock your keyring and try again. Review CLI sessions in BlinkHost settings if you need to revoke access.',
    EXIT.auth, 'credential_store_failed');
}

export async function getRefreshCredential(profile: string): Promise<string | null> {
  if (process.platform === 'darwin') return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', profile, '-w'], undefined, true)) || null;
  if (process.platform === 'win32') return (await windowsCredential('get', profile)) || null;
  const value = await run('secret-tool', ['lookup', 'service', SERVICE, 'profile', profile], undefined, true);
  if (value) return value;
  if (await linuxCredentialExists(profile)) throw inaccessibleCredential();
  return null;
}

export async function setRefreshCredential(profile: string, token: string): Promise<void> {
  if (!token.startsWith('bhr_')) throw new CliError('The server returned an invalid refresh credential.', EXIT.auth, 'invalid_refresh_credential');
  if (process.platform === 'darwin') {
    const request = macosKeychainWrite(profile, token);
    await run(request.command, request.args, request.input);
    return;
  }
  if (process.platform === 'win32') { await windowsCredential('set', profile, token); return; }
  await run('secret-tool', ['store', '--label=BlinkHost CLI', 'service', SERVICE, 'profile', profile], token);
}

export async function deleteRefreshCredential(profile: string): Promise<void> {
  if (process.platform === 'darwin') { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', profile], undefined, true); return; }
  if (process.platform === 'win32') { await windowsCredential('delete', profile); return; }
  await run('secret-tool', ['clear', 'service', SERVICE, 'profile', profile], undefined, true);
  if (await linuxCredentialExists(profile)) throw inaccessibleCredential();
}
