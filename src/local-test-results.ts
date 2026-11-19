import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT } from './errors.js';
import { sanitizeLocalTestOutput } from './local-test-command.js';

export const LOCAL_TEST_RESULT_LIMITS = { bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, tests: 10_000 } as const;
type Profile = 'native' | 'wasm' | 'browser' | 'unspecified';
export type LocalTestResultStatus = 'passed' | 'failed' | 'no_tests' | 'skipped' | 'unsupported';
export interface LocalTestCounts { total: number; passed: number; failed: number; skipped: number; unsupported: number }
interface CoverageMetric { covered: number; total: number }
export interface LocalTestReport {
  schema: 'blinkhost.local-test-results/v1';
  authority: 'customer_runner_reported';
  source_sha256: string;
  source_bytes: number;
  runner: string;
  profile: Profile;
  status: LocalTestResultStatus;
  counts: LocalTestCounts;
  tests: Array<{ id: string; name: string; status: 'passed' | 'failed' | 'skipped' | 'unsupported';
    duration_ms?: number; message?: string; stack?: string }>;
  coverage: { status: 'collected' | 'unavailable' | 'not_collected';
    profile: Profile; authority: 'customer_runner_reported';
    metrics?: Partial<Record<'lines' | 'branches' | 'functions', CoverageMetric>> };
  sanitization: 'common_credentials_terminal_controls_and_run_context';
}
export interface LocalTestResultSink {
  directory: string; path: string; runId: string; device: number; inode: number;
}

function invalid(): never {
  // Never include untrusted fields, paths, parser errors or result bytes in CLI errors.
  throw new CliError('The local runner result is invalid or does not match this check.', EXIT.validation, 'invalid_local_test_results');
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !fields.includes(key))) invalid();
  return row;
}
function integer(value: unknown, maximum = 1_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
export function screenLocalTestRunContext(value: string, sink: LocalTestResultSink): string {
  let screened = sanitizeLocalTestOutput(value);
  for (const secret of [sink.path, sink.directory, sink.runId]) screened = screened.split(secret).join('[LOCAL TEST CONTEXT]');
  return screened;
}
function text(value: unknown, maximum: number, sink: LocalTestResultSink): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) invalid();
  return screenLocalTestRunContext(value, sink);
}

/** One new directory and unpredictable run ID per check. Neither is returned in public receipts. */
export async function createLocalTestResultSink(): Promise<LocalTestResultSink> {
  const directory = await mkdtemp(join(tmpdir(), 'blinkhost-test-result-'));
  const stat = await lstat(directory);
  return { directory, path: join(directory, 'results.json'), runId: randomUUID(), device: stat.dev, inode: stat.ino };
}
export async function removeLocalTestResultSink(sink: LocalTestResultSink): Promise<void> {
  // Clean only the directory created for this check; do not touch project result files.
  const stat = await lstat(sink.directory).catch(() => null);
  if (stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === sink.device && stat.ino === sink.inode) {
    await rm(sink.directory, { recursive: true, force: true });
  }
}

/** Canonical customer report import, not executor certification or promotion authority. */
export async function readLocalTestResults(sink: LocalTestResultSink, check: { id: string; profile: Profile }, remainingBytes: number = LOCAL_TEST_RESULT_LIMITS.bytes): Promise<LocalTestReport> {
  const maximum = Math.min(LOCAL_TEST_RESULT_LIMITS.bytes, remainingBytes);
  if (!Number.isSafeInteger(maximum) || maximum < 1) invalid();
  let file;
  try {
    const directory = await lstat(sink.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== sink.device || directory.ino !== sink.inode) invalid();
    const stat = await lstat(sink.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) invalid();
    file = await open(sink.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size > maximum) invalid();
  } catch (error) {
    await file?.close();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('The local runner did not produce its required result file.', EXIT.validation, 'missing_local_test_results');
    }
    invalid();
  }
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(maximum + 1);
    // A bounded read, including concurrent file growth. Short reads are legal.
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) invalid();
    bytes = buffer.subarray(0, size);
  } catch { invalid();
  } finally { await file.close(); }
  return parseLocalTestResults(bytes, sink, check, maximum);
}

/** Bounded import of captured runner bytes. This never certifies their truth or grants gate authority. */
export function parseLocalTestResults(bytes: Buffer, sink: LocalTestResultSink,
  check: { id: string; profile: Profile }, remainingBytes: number = LOCAL_TEST_RESULT_LIMITS.bytes): LocalTestReport {
  const maximum = Math.min(LOCAL_TEST_RESULT_LIMITS.bytes, remainingBytes);
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maximum) || maximum < 1
    || !bytes.length || bytes.length > maximum) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); }
  const report = object(parsed, ['schema', 'run_id', 'check_id', 'runner', 'profile', 'tests', 'coverage']);
  if (report.schema !== 'blinkhost.local-test-results/v1' || report.run_id !== sink.runId
    || report.check_id !== check.id || report.profile !== check.profile) invalid();
  const runner = text(report.runner, 128, sink);
  if (!Array.isArray(report.tests) || report.tests.length > LOCAL_TEST_RESULT_LIMITS.tests) invalid();
  const counts: LocalTestCounts = { total: report.tests.length, passed: 0, failed: 0, skipped: 0, unsupported: 0 };
  const ids = new Set<string>();
  const tests = report.tests.map(value => {
    const row = object(value, ['id', 'name', 'status', 'duration_ms', 'message', 'stack']);
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(row.id) || ids.has(row.id)) invalid();
    ids.add(row.id);
    if (!['passed', 'failed', 'skipped', 'unsupported'].includes(String(row.status))) invalid();
    const status = row.status as LocalTestReport['tests'][number]['status'];
    counts[status]++;
    return { id: row.id, name: text(row.name, 1024, sink), status,
      ...(row.duration_ms !== undefined ? { duration_ms: integer(row.duration_ms) } : {}),
      ...(row.message !== undefined ? { message: text(row.message, 4096, sink) } : {}),
      ...(row.stack !== undefined ? { stack: text(row.stack, 16_384, sink) } : {}) };
  });
  const rawCoverage = report.coverage === undefined ? { status: 'not_collected' } : object(report.coverage, ['status', 'metrics']);
  if (!['collected', 'unavailable', 'not_collected'].includes(String(rawCoverage.status))) invalid();
  let metrics: LocalTestReport['coverage']['metrics'];
  if (rawCoverage.status === 'collected') {
    const rawMetrics = object(rawCoverage.metrics, ['lines', 'branches', 'functions']);
    if (!Object.keys(rawMetrics).length || !counts.passed && !counts.failed) invalid();
    metrics = {};
    for (const key of ['lines', 'branches', 'functions'] as const) {
      if (rawMetrics[key] === undefined) continue;
      const metric = object(rawMetrics[key], ['covered', 'total']);
      const covered = integer(metric.covered), total = integer(metric.total);
      if (covered > total) invalid();
      metrics[key] = { covered, total };
    }
  } else if (rawCoverage.metrics !== undefined) invalid();
  const status: LocalTestResultStatus = counts.failed ? 'failed' : counts.passed ? 'passed'
    : !counts.total ? 'no_tests' : counts.unsupported === counts.total ? 'unsupported' : 'skipped';
  return { schema: 'blinkhost.local-test-results/v1', authority: 'customer_runner_reported',
    source_sha256: createHash('sha256').update(bytes).digest('hex'), source_bytes: bytes.length, runner, profile: check.profile, status, counts, tests,
    coverage: { status: rawCoverage.status as LocalTestReport['coverage']['status'], profile: check.profile,
      authority: 'customer_runner_reported', ...(metrics ? { metrics } : {}) },
    sanitization: 'common_credentials_terminal_controls_and_run_context' };
}
