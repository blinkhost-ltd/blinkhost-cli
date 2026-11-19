import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_TEST_RESULT_LIMITS } from './local-test-results.js';
import { sanitizeLocalTestOutput } from './local-test-command.js';

interface TestRow { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; duration_ms: number; message?: string }
interface ActiveTest { name: string; output: string }
interface PackageState { finished: boolean; failed: boolean; active: Map<string, ActiveTest> }
interface Context { path: string; runId: string; checkId: string }
const EVENT_BYTES = 64 * 1024;
const STREAM_BYTES = 32 * 1024 * 1024;
const DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
function fail(): never { throw new Error('The BlinkHost Go test runner could not qualify this result.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > EVENT_BYTES) fail();
  return value;
}
function context(): Context {
  const env = process.env;
  if (!env.BLINKHOST_TEST_RESULT_PATH || !env.BLINKHOST_TEST_RUN_ID || !env.BLINKHOST_TEST_CHECK_ID
    || env.BLINKHOST_TEST_PROFILE !== 'native') {
    throw new Error('Run the Go adapter through a BlinkHost structured test check with profile native.');
  }
  return { path: env.BLINKHOST_TEST_RESULT_PATH, runId: env.BLINKHOST_TEST_RUN_ID, checkId: env.BLINKHOST_TEST_CHECK_ID };
}
function safeText(value: string, maximum: number, ctx: Context): string {
  let screened = sanitizeLocalTestOutput(value);
  for (const secret of [ctx.path, dirname(ctx.path), ctx.runId]) screened = screened.split(secret).join('[LOCAL TEST CONTEXT]');
  let result = '', bytes = 0;
  for (const character of screened) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximum) break;
    result += character;
  }
  return result.trim() || '(unavailable)';
}

/** Consumes actual go test -json events. Package checks are never invented application tests. */
export class GoTestEvents {
  readonly tests: TestRow[] = [];
  private packages = new Map<string, PackageState>();
  private startedTests = 0;
  private diagnosticBytes = 0;
  private buildFailed = false;
  constructor(private readonly ctx: Context) {}
  accept(value: unknown): string | undefined {
    const event = record(value);
    const action = string(event.Action);
    if (action === 'build-output' || action === 'build-fail') {
      string(event.ImportPath);
      if (action === 'build-fail') { this.buildFailed = true; return; }
      return string(event.Output);
    }
    const packageName = string(event.Package);
    const testName = event.Test === undefined ? undefined : string(event.Test);
    if (action === 'start') {
      if (testName || this.packages.has(packageName) || this.packages.size >= LOCAL_TEST_RESULT_LIMITS.tests) fail();
      this.packages.set(packageName, { finished: false, failed: false, active: new Map() });
      return;
    }
    const pkg = this.packages.get(packageName);
    if (!pkg || pkg.finished) fail();
    if (action === 'run') {
      if (!testName || pkg.active.has(testName) || ++this.startedTests > LOCAL_TEST_RESULT_LIMITS.tests) fail();
      pkg.active.set(testName, { name: packageName + '/' + testName, output: '' });
    } else if (action === 'output') {
      const output = string(event.Output);
      const test = testName ? pkg.active.get(testName) : undefined;
      // Go emits framing output after terminal events; it is not another test.
      if (test) {
        this.diagnosticBytes += Buffer.byteLength(output);
        if (this.diagnosticBytes > DIAGNOSTIC_BYTES || Buffer.byteLength(test.output) + Buffer.byteLength(output) > EVENT_BYTES) fail();
        test.output += output;
      }
      return output;
    } else if (action === 'pause' || action === 'cont') {
      if (!testName || !pkg.active.has(testName)) fail();
    } else if (action === 'pass' || action === 'fail' || action === 'skip') {
      if (!testName) {
        if (pkg.active.size) fail();
        pkg.finished = true;
        pkg.failed = action === 'fail';
        return;
      }
      const test = pkg.active.get(testName);
      if (!test) fail();
      const elapsed = event.Elapsed ?? 0;
      if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 1_000_000) fail();
      const status = action === 'pass' ? 'passed' : action === 'fail' ? 'failed' : 'skipped';
      this.tests.push({ id: `go-${this.tests.length + 1}`, name: safeText(test.name, 1024, this.ctx), status,
        duration_ms: Math.round(elapsed * 1000),
        ...(status !== 'passed' && test.output.trim() ? { message: safeText(test.output, 4096, this.ctx) } : {}) });
      pkg.active.delete(testName);
    } else fail();
  }
  finish(exitCode: number): TestRow[] {
    if (!this.packages.size || this.startedTests !== this.tests.length
      // A failed package that never reached a test has no test report. Keep
      // successful empty suites distinct from compilation/setup failures.
      || exitCode !== 0 && this.tests.length === 0
      || [...this.packages.values()].some(pkg => !pkg.finished || pkg.active.size)
      || exitCode === 0 && (this.buildFailed || [...this.packages.values()].some(pkg => pkg.failed)
        || this.tests.some(test => test.status === 'failed'))) fail();
    return this.tests;
  }
}

/** Native test execution only. Parent CLI owns timeout, output budget and process-group cleanup. */
export async function runGoTests(args: string[]): Promise<number> {
  const ctx = context();
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (process.env.GOOS && process.env.GOOS !== os || process.env.GOARCH && process.env.GOARCH !== arch) fail();
  // These modes cannot provide a complete ordinary test event stream. GOFLAGS
  // is cleared so inherited flags cannot silently change the adapter's mode.
  if (args.some(arg => /^-{1,2}(?:test\.)?(?:c|list|bench|benchtime|fuzz|fuzztime|fuzzminimizetime|json|exec|args)(?:=|$)/.test(arg))) fail();
  const env = { ...process.env, GOFLAGS: '' };
  const version = execFileSync('go', ['version'], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 }).trim();
  if (!/^go version go[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[a-z]+[0-9]+)? \S+\/\S+$/.test(version)) fail();
  const events = new GoTestEvents(ctx);
  const child = spawn('go', ['test', '-json', ...args], { env, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  // Attach a rejection handler immediately, even while reading the stream.
  void closed.catch(() => {});
  let pending = Buffer.alloc(0), observed = 0;
  try {
    for await (const chunk of child.stdout) {
      observed += chunk.length;
      if (observed > STREAM_BYTES) fail();
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > EVENT_BYTES) fail();
        const line = new TextDecoder('utf8', { fatal: true }).decode(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
        const output = events.accept(JSON.parse(line));
        if (output && !process.stdout.write(output)) await once(process.stdout, 'drain');
      }
      if (pending.length > EVENT_BYTES) fail();
    }
    if (pending.length) fail();
    const result = await closed;
    if (result.signal || result.code === null) fail();
    const tests = events.finish(result.code);
    const encoded = JSON.stringify({ schema: 'blinkhost.local-test-results/v1', run_id: ctx.runId,
      check_id: ctx.checkId, profile: 'native', runner: `go:test/${version.split(' ')[2]}`, tests,
      coverage: { status: 'not_collected' } });
    if (Buffer.byteLength(encoded) > LOCAL_TEST_RESULT_LIMITS.bytes) fail();
    const file = await open(ctx.path, 'wx', 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    return result.code;
  } catch (error) {
    // The parent command's owned group supplies escalation and descendant cleanup.
    child.kill('SIGTERM');
    child.stdout.destroy();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGoTests(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('The BlinkHost Go test runner failed; no passing result was certified.\n');
    process.exitCode = 2;
  });
}
