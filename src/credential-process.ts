import { spawn } from 'node:child_process';
import { CliError, EXIT } from './errors.js';

const MAX_OUTPUT_BYTES = 16 * 1024;
type Options = {
  input?: string;
  timeoutMs?: number;
  missing?: { code: number; requireEmptyStderr: boolean };
};

export type CredentialProbe = { available: true } | {
  available: false;
  failureCode: 'credential_store_timeout' | 'credential_store_unavailable'
    | 'credential_store_response_invalid' | 'credential_store_failed';
};

/** Read-only availability checks retain a safe category, never native output. */
export async function credentialProbe(command: string, args: string[], timeoutMs = 5000): Promise<CredentialProbe> {
  try {
    await credentialCommand(command, args, { timeoutMs });
    return { available: true };
  } catch (error) {
    const code = error instanceof CliError ? error.code : undefined;
    const failureCode = code === 'credential_store_timeout' || code === 'credential_store_unavailable'
      || code === 'credential_store_response_invalid' ? code : 'credential_store_failed';
    return { available: false, failureCode };
  }
}

/** OS credential helpers only; never retry a possibly completed credential write. */
export async function credentialCommand(command: string, args: string[], options: Options = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new CliError('Invalid credential-service timeout.', EXIT.internal, 'credential_store_configuration_invalid');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderrPresent = false;
    let finished = false;
    const finish = (error?: CliError, value = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      } else resolve(value);
    };
    const failed = () => new CliError(
      'The operating-system credential service could not complete the request. Unlock or restart your keyring and try again. If this happened after browser approval, review CLI sessions in BlinkHost settings before starting another sign-in.',
      EXIT.auth, 'credential_store_failed');
    const timer = setTimeout(() => finish(new CliError(
      'The operating-system credential service did not respond in time. Unlock or restart your keyring. If browser approval already succeeded, review CLI sessions in BlinkHost settings before starting another sign-in.',
      EXIT.auth, 'credential_store_timeout')), timeoutMs);
    const collect = (chunk: Buffer, stderr: boolean) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(new CliError('The operating-system credential service returned an unexpected response. No diagnostic output was displayed.',
          EXIT.auth, 'credential_store_response_invalid'));
        return;
      }
      if (stderr) stderrPresent ||= chunk.length > 0;
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stdin.on('error', () => finish(failed()));
    child.once('error', () => finish(new CliError('No supported operating-system credential service is available.',
      EXIT.auth, 'credential_store_unavailable')));
    child.once('close', code => {
      if (code === 0) finish(undefined, Buffer.concat(chunks).toString('utf8').trim());
      else if (options.missing && code === options.missing.code
        && (!options.missing.requireEmptyStderr || !stderrPresent)) finish();
      else finish(failed());
    });
    child.stdin.end(options.input);
  });
}
