import { spawn } from 'node:child_process';
import { CliError, EXIT } from './errors.js';

export const LOCAL_TEST_LIMITS = {
  timeoutMs: 900_000, maxTimeoutMs: 3_600_000,
  maxOutputBytes: 1024 * 1024, maximumOutputBytes: 8 * 1024 * 1024,
  terminationGraceMs: 1000,
} as const;

export interface LocalTestCommandResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit' | 'unavailable';
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  observed_output_bytes: number;
  captured_output_bytes: number;
  output: { stdout: string; stderr: string; sanitization: 'common_credentials_and_terminal_controls' };
  limits: { timeout_ms: number; max_output_bytes: number; termination_grace_ms: number };
  cleanup: { scope: 'posix_process_group' | 'direct_child'; kill_requested: boolean };
}

export class LocalTestChecksFailure extends CliError {
  constructor(message: string, exitCode: number, code: string, details: string[] = [], readonly projectChecks?: unknown) {
    super(message, exitCode, code, details);
  }
}

export class LocalTestCommandFailure extends LocalTestChecksFailure {
  constructor(message: string, exitCode: number, code: string,
    readonly execution: LocalTestCommandResult, details: string[] = [], projectChecks?: unknown) {
    super(message, exitCode, code, details, projectChecks);
  }
}

/** Heuristic screening of local diagnostics, not a guarantee that output is secret-free. */
export function sanitizeLocalTestOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Local customer commands only. Process groups are cleanup scope, not a security sandbox. */
export async function runLocalTestCommand(command: string, args: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number;
  terminationGraceMs?: number; signal?: AbortSignal;
}): Promise<LocalTestCommandResult> {
  const timeoutMs = options.timeoutMs ?? LOCAL_TEST_LIMITS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? LOCAL_TEST_LIMITS.maxOutputBytes;
  const graceMs = options.terminationGraceMs ?? LOCAL_TEST_LIMITS.terminationGraceMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LOCAL_TEST_LIMITS.maxTimeoutMs
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > LOCAL_TEST_LIMITS.maximumOutputBytes
    || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 5000) {
    throw new CliError('Invalid local test execution limits.', EXIT.usage, 'invalid_test_limits');
  }
  const group = process.platform !== 'win32';
  const started = performance.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let captured = 0;
  let killRequested = false;
  const receipt = (status: LocalTestCommandResult['status'], code: number | null, signal: NodeJS.Signals | null): LocalTestCommandResult => ({
    status, exit_code: code, signal, duration_ms: Math.round(performance.now() - started),
    observed_output_bytes: bytes, captured_output_bytes: captured,
    output: { stdout: sanitizeLocalTestOutput(Buffer.concat(stdout).toString('utf8')),
      stderr: sanitizeLocalTestOutput(Buffer.concat(stderr).toString('utf8')),
      sanitization: 'common_credentials_and_terminal_controls' },
    limits: { timeout_ms: timeoutMs, max_output_bytes: maxOutputBytes, termination_grace_ms: graceMs },
    cleanup: { scope: group ? 'posix_process_group' : 'direct_child', kill_requested: killRequested },
  });
  if (options.signal?.aborted) return receipt('cancelled', null, null);
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      shell: false, detached: group, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let finished = false;
    let termination: LocalTestCommandResult['status'] | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (group) process.kill(-child.pid, signal);
        else child.kill(signal);
        if (signal === 'SIGKILL') killRequested = true;
      } catch { /* ESRCH means this owned process/group already exited. */ }
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      // Clean up descendants that outlived a successful root test process, too.
      kill('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy();
      resolve(receipt(termination ?? (code === 0 ? 'succeeded' : 'failed'), code, signal));
    };
    const stop = (reason: LocalTestCommandResult['status']) => {
      if (finished || termination) return;
      termination = reason;
      kill('SIGTERM');
      escalation = setTimeout(() => {
        kill('SIGKILL');
        // Bound inherited pipes even when a child escapes the owned process group.
        finish(child.exitCode, child.signalCode);
      }, graceMs);
    };
    const abort = () => stop('cancelled');
    const collect = (chunk: Buffer, output: Buffer[]) => {
      if (finished || termination) return;
      bytes += chunk.length;
      const remaining = maxOutputBytes - captured;
      if (chunk.length <= remaining) { output.push(chunk); captured += chunk.length; }
      // Drop the overflowing chunk whole; do not expose a partially cut credential.
      else stop('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr));
    child.once('error', () => { termination ??= 'unavailable'; finish(null, null); });
    child.once('close', finish);
    options.signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => stop('timed_out'), timeoutMs);
    if (options.signal?.aborted) abort();
  });
}
