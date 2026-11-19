import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL_TEST_RESULT_LIMITS } from './local-test-results.js';
import { sanitizeLocalTestOutput } from './local-test-command.js';

interface Event { type: string; data: Record<string, unknown> }
interface TestRow { id: string; name: string; status: 'passed' | 'failed' | 'skipped';
  duration_ms: number; message?: string; stack?: string }
interface TerminalRow { test: TestRow; file: string | undefined; fileCandidate: boolean; order: number }
function fail(): never { throw new Error('The BlinkHost Node test reporter could not qualify this runner result.'); }
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) fail();
  return value;
}
function safeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') fail();
  const screened = sanitizeLocalTestOutput(value);
  // Screen whole strings before truncation, so a cut credential cannot bypass screening.
  let result = '';
  let bytes = 0;
  for (const character of screened) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximum) break;
    result += character;
  }
  return result || '(unavailable)';
}

/** node:test event adapter. Node execution is native; it never claims browser or WASM coverage. */
export default async function* blinkhostNodeReporter(source: AsyncIterable<Event>): AsyncGenerator<string> {
  const env = process.env;
  if (!env.BLINKHOST_TEST_RESULT_PATH || !env.BLINKHOST_TEST_RUN_ID || !env.BLINKHOST_TEST_CHECK_ID
    || env.BLINKHOST_TEST_PROFILE !== 'native') {
    throw new Error('Run this reporter through a BlinkHost structured test check with profile native.');
  }
  const terminal: TerminalRow[] = [];
  const fileWrappers: { passed: number; failed: number; skipped: number } = { passed: 0, failed: 0, skipped: 0 };
  const fileSummaries = new Map<string, { counts: Record<string, unknown>; order: number }>();
  let order = 0;
  let summary: Record<string, unknown> | undefined;
  let coverage: Record<string, unknown> = { status: 'not_collected' };
  for await (const event of source) {
    order++;
    const data = event.data;
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      if (typeof data.message !== 'string') fail();
      // Forward customer output intact to the parent CLI. Its shared byte
      // budget must see every byte before it screens captured diagnostics;
      // dropping or truncating these events would hide output-limit breaches.
      yield data.message;
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const details = row(data.details);
      if (details.type === 'suite') continue;
      if (terminal.length >= LOCAL_TEST_RESULT_LIMITS.tests) fail();
      if (typeof details.duration_ms !== 'number' || !Number.isFinite(details.duration_ms)
        || details.duration_ms < 0 || details.duration_ms > 1_000_000_000) fail();
      const skipped = data.skip !== undefined && data.skip !== false || data.todo !== undefined && data.todo !== false;
      const status = skipped ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed';
      const error = details.error && typeof details.error === 'object' ? details.error as Record<string, unknown> : undefined;
      terminal.push({ order, file: typeof data.file === 'string' ? data.file : undefined,
        // This identifies a candidate only: an application may itself use its
        // filename as a test name, including at line/column 1.
        fileCandidate: data.nesting === 0 && data.line === 1 && data.column === 1
          && typeof data.file === 'string' && typeof data.name === 'string' && resolve(data.name) === data.file,
        test: { id: `node-${terminal.length + 1}`, name: safeText(data.name, 1024), status,
        duration_ms: Math.round(details.duration_ms),
        ...(error && typeof error.message === 'string' ? { message: safeText(error.message, 4096) } : {}),
        ...(error && typeof error.stack === 'string' ? { stack: safeText(error.stack, 16_384) } : {}) } });
    } else if (event.type === 'test:summary') {
      if (data.file === undefined) {
        if (summary) fail();
        summary = row(data.counts);
      } else {
        if (typeof data.file !== 'string' || fileSummaries.has(data.file)
          || fileSummaries.size >= LOCAL_TEST_RESULT_LIMITS.tests) fail();
        fileSummaries.set(data.file, { counts: row(data.counts), order });
      }
    } else if (event.type === 'test:coverage') {
      const totals = row(row(data.summary).totals);
      const metric = (covered: string, total: string) => {
        const result = { covered: count(totals[covered]), total: count(totals[total]) };
        if (result.covered > result.total) fail();
        return result;
      };
      coverage = { status: 'collected', metrics: {
        lines: metric('coveredLineCount', 'totalLineCount'),
        branches: metric('coveredBranchCount', 'totalBranchCount'),
        functions: metric('coveredFunctionCount', 'totalFunctionCount'),
      } };
    } else if (event.type === 'test:diagnostic' && typeof data.message === 'string') {
      yield safeText(data.message, 4096) + '\n';
    }
  }
  if (!summary) fail();
  // Node's root count also includes synthetic file checks; child summaries
  // count declared application tests. Exclude candidates only when both
  // aggregates corroborate their number. Ambiguous/unsupported streams fail.
  const childTotals = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  for (const { counts } of fileSummaries.values()) {
    childTotals.tests += count(counts.tests);
    childTotals.passed += count(counts.passed);
    childTotals.failed += count(counts.failed) + count(counts.cancelled);
    childTotals.skipped += count(counts.skipped) + count(counts.todo);
  }
  const wrapperCount = count(summary.tests) - childTotals.tests;
  if (wrapperCount < 0) fail();
  const candidates = terminal.filter(item => item.fileCandidate
    && (!fileSummaries.has(item.file!) || item.order > fileSummaries.get(item.file!)!.order));
  if (wrapperCount > 0 && candidates.length !== wrapperCount) fail();
  const excluded = new Set(wrapperCount > 0 ? candidates : []);
  const tests: TestRow[] = [];
  for (const item of terminal) {
    if (excluded.has(item)) {
      fileWrappers[item.test.status]++;
      yield `${item.test.status}: test-file execution (${item.test.status === 'passed' ? 'no declared tests' : 'no test result'})\n`;
    } else {
      tests.push({ ...item.test, id: `node-${tests.length + 1}` });
      yield `${item.test.status}: ${item.test.name}\n`;
    }
  }
  if (tests.length !== childTotals.tests
    || tests.filter(test => test.status === 'passed').length !== childTotals.passed
    || tests.filter(test => test.status === 'failed').length !== childTotals.failed
    || tests.filter(test => test.status === 'skipped').length !== childTotals.skipped) fail();
  // Reconcile actual terminal events against Node's final aggregate. Missing events fail closed.
  if (count(summary.tests) !== tests.length + fileWrappers.passed + fileWrappers.failed + fileWrappers.skipped
    || count(summary.passed) !== tests.filter(test => test.status === 'passed').length + fileWrappers.passed
    || count(summary.failed) + count(summary.cancelled) !== tests.filter(test => test.status === 'failed').length + fileWrappers.failed
    || count(summary.skipped) + count(summary.todo) !== tests.filter(test => test.status === 'skipped').length + fileWrappers.skipped) fail();
  if (!tests.some(test => test.status === 'passed' || test.status === 'failed') && coverage.status === 'collected') {
    coverage = { status: 'unavailable' };
  }
  const encoded = JSON.stringify({ schema: 'blinkhost.local-test-results/v1', run_id: env.BLINKHOST_TEST_RUN_ID,
    check_id: env.BLINKHOST_TEST_CHECK_ID, profile: 'native', runner: `node:test/${process.version}`, tests, coverage });
  if (Buffer.byteLength(encoded) > LOCAL_TEST_RESULT_LIMITS.bytes) fail();
  await writeFile(env.BLINKHOST_TEST_RESULT_PATH, encoded, { flag: 'wx', mode: 0o600 });
}
