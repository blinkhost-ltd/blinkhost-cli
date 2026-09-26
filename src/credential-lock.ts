import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateProfileName } from './config.js';
import { CliError, EXIT } from './errors.js';

// The OS credential store keys by profile, independently of CONFIG_HOME and
// API origin. Commands using different config files must therefore share locks.
export function credentialLockPath(profile: string): string {
  return join(homedir(), '.blinkhost', 'credential-locks', `${validateProfileName(profile)}.lock`);
}

/** Serialize the complete read/rotate/save operation across CLI processes. */
export async function withCredentialLock<T>(profile: string, operation: () => Promise<T>, timeoutMs = 45_000): Promise<T> {
  const path = credentialLockPath(profile);
  const directory = join(homedir(), '.blinkhost', 'credential-locks');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000) {
    throw new CliError('The CLI credential lock timeout is invalid.', EXIT.internal, 'credential_lock_invalid');
  }
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch { throw new CliError('The CLI credential lock directory is unavailable.', EXIT.filesystem, 'credential_lock_failed'); }
  const deadline = performance.now() + timeoutMs;
  let handle;
  while (!handle) {
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CliError('The CLI credential lock is unavailable.', EXIT.filesystem, 'credential_lock_failed');
      }
      if (performance.now() >= deadline) {
        // Never steal an old lock based on time alone: a suspended process may
        // still rotate the credential when it resumes. This file has no secrets.
        throw new CliError('Another CLI command holds this profile’s sign-in lock. Let it finish and retry. If it exited unexpectedly, confirm no CLI command is running before removing the lock file.',
          EXIT.conflict, 'credential_busy', [path]);
      }
      await delay(Math.min(50, Math.max(1, deadline - performance.now())));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
    return await operation();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
