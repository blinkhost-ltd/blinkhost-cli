import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_TEST_RESULT_LIMITS } from './local-test-results.js';
import { sanitizeLocalTestOutput } from './local-test-command.js';

interface Context { path: string; runId: string; checkId: string }
interface TestRow { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; message?: string }
const OUTPUT_BYTES = 1024 * 1024;
function fail(): never { throw new Error('The BlinkHost Rust test runner could not qualify this result.'); }
function context(): Context {
  const env = process.env;
  if (!env.BLINKHOST_TEST_RESULT_PATH || !env.BLINKHOST_TEST_RUN_ID || !env.BLINKHOST_TEST_CHECK_ID
    || env.BLINKHOST_TEST_PROFILE !== 'native') fail();
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

/** Pinned stable libtest census: unsupported/custom output fails closed. */
export function rustTestCensus(output: string): string[] {
  const names = output.split('\n').filter(Boolean).map(line => {
    if (!line.endsWith(': test')) fail();
    const name = line.slice(0, -6);
    if (!name || Buffer.byteLength(name) > 4096) fail();
    return name;
  });
  if (names.length > LOCAL_TEST_RESULT_LIMITS.tests || new Set(names).size !== names.length) fail();
  return names;
}

/** Reconciles every selected test, native exit and the stable libtest summary. */
export function rustTestResults(output: string, names: string[], ignored: Set<string>, exitCode: number,
  ctx: Context): Omit<TestRow, 'id'>[] {
  const lines = output.split('\n');
  const summaries = lines.filter(line => line.startsWith('test result: '));
  if (summaries.length !== 1) fail();
  const summary = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in (\d+(?:\.\d+)?)s$/.exec(summaries[0]!);
  if (!summary || Number(summary[5]) !== 0 || (summary[1] === 'ok') !== (exitCode === 0)) fail();
  const expected = new Set(names);
  const terminal = new Map<string, 'passed' | 'failed' | 'skipped'>();
  let failures = false;
  for (const line of lines) {
    if (line === 'failures:') failures = true;
    if (failures || !line.startsWith('test ') || line.startsWith('test result: ')) continue;
    const match = /^test (.+) \.\.\. (ok|FAILED|ignored(?:, .*)?)$/.exec(line);
    if (!match || !expected.has(match[1]!) || terminal.has(match[1]!)) fail();
    const status = match[2] === 'ok' ? 'passed' : match[2] === 'FAILED' ? 'failed' : 'skipped';
    if ((status === 'skipped') !== ignored.has(match[1]!)) fail();
    terminal.set(match[1]!, status);
  }
  if (terminal.size !== expected.size) fail();
  const values = [...terminal.values()];
  if (Number(summary[2]) !== values.filter(status => status === 'passed').length
    || Number(summary[3]) !== values.filter(status => status === 'failed').length
    || Number(summary[4]) !== values.filter(status => status === 'skipped').length
    || exitCode === 0 && values.includes('failed')) fail();
  // Individual test durations are unavailable in stable pretty output. Never
  // divide suite timing between tests or fabricate a per-test duration.
  return names.map(name => {
    let diagnostic = '';
    const header = lines.indexOf(`---- ${name} stdout ----`);
    if (header !== -1) {
      for (const line of lines.slice(header+1)) {
        if (line === 'failures:' || line.startsWith('---- ') && line.endsWith(' stdout ----')
          || line.startsWith('test result: ')) break;
        diagnostic += line+'\n';
      }
    }
    return { name: safeText(name, 1024, ctx), status: terminal.get(name)!,
      ...(terminal.get(name) === 'failed' ? { message: safeText(diagnostic || 'Native test failed; see bounded command output.',4096,ctx) } : {}) };
  });
}

async function capture(command: string, args: string[], visible: boolean): Promise<{ output: string; code: number }> {
  const child = spawn(command, args, { shell: false, stdio: ['ignore','pipe','inherit'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  void closed.catch(() => {});
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) fail();
      chunks.push(chunk);
      if (visible && !process.stdout.write(chunk)) await once(process.stdout, 'drain');
    }
    const result = await closed;
    if (result.signal || result.code === null) fail();
    return { output: new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)), code: result.code };
  } catch (error) { child.kill('SIGTERM'); child.stdout.destroy(); throw error; }
}

/** Cargo consumes TESTNAME during --no-run, so carry it into each libtest call.
 * Account for option values explicitly; guessing would turn a package/path or
 * future Cargo option into a different customer test selection. */
function cargoTestFilter(args: string[]): string | undefined {
  const values = new Set(['--package','-p','--exclude','--bin','--example','--test',
    '--jobs','-j','--profile','--features','-F','--target-dir','--manifest-path',
    '--config','--color','--lockfile-path']);
  const flags = new Set(['--workspace','--all','--lib','--bins','--examples','--tests',
    '--release','--all-features','--no-default-features','--ignore-rust-version',
    '--future-incompat-report','--no-fail-fast','--verbose','--quiet',
    '--frozen','--locked','--offline']);
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (values.has(arg)) {
      if (!args[++i] || args[i]!.startsWith('-')) fail();
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals !== -1 && values.has(arg.slice(0,equals))) {
        if (!arg.slice(equals+1)) fail();
      } else if (arg !== '--timings' && arg !== '--timings=html' && !flags.has(arg)) fail();
    } else if (arg.startsWith('-')) {
      if (!/^-[vqr]+$/.test(arg) && !/^-[jpF].+/.test(arg)) fail();
    } else {
      if (filter !== undefined) fail();
      filter = arg;
    }
  }
  return filter;
}

/** Stable native Cargo/libtest adapter. Cargo build scripts/tests use local customer permissions. */
export async function runRustTests(args: string[]): Promise<number> {
  const ctx = context();
  const separator = args.indexOf('--');
  const cargoArgs = separator === -1 ? args : args.slice(0,separator);
  const testArgs = separator === -1 ? [] : args.slice(separator+1);
  // Preserve a complete ordinary libtest protocol, without nightly options,
  // uncaptured customer output or alternate build/execution modes.
  if (cargoArgs.some(arg => /^-{1,2}(?:message-format|no-run|doc|benches|bench|all-targets|target)(?:=|$)/.test(arg))
    || testArgs.some(arg => /^-{1,2}(?:format|color|list|bench|nocapture|show-output|logfile|report-time|ensure-time|Z)(?:=|$)/.test(arg))
    || testArgs.includes('--')) fail();
  const filter = cargoTestFilter(cargoArgs);
  if (filter !== undefined) testArgs.unshift(filter);
  const version = execFileSync('rustc',['--version'],{ encoding:'utf8',timeout:10000,maxBuffer:4096 }).trim();
  if (!/^rustc [0-9]+\.[0-9]+\.[0-9]+ \([^)]+\)$/.test(version)) fail();
  const build = await capture('cargo',['test','--no-run','--message-format=json',...cargoArgs],true);
  if (build.code !== 0) return build.code;
  const binaries: { path: string; label: string }[] = [];
  let finished = false;
  for (const line of build.output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
    if (event.reason === 'build-finished') {
      if (finished || event.success !== true) fail();
      finished = true;
    } else if (event.reason === 'compiler-artifact' && event.profile?.test === true && event.executable) {
      if (typeof event.executable !== 'string' || typeof event.target?.name !== 'string'
        || typeof event.package_id !== 'string' || !Array.isArray(event.target.kind)
        || event.target.kind.some((kind: unknown) => !['lib','bin','test','example'].includes(String(kind)))) fail();
      binaries.push({ path:event.executable,label:event.package_id+'/'+event.target.name });
    }
  }
  if (!finished || !binaries.length || binaries.length > LOCAL_TEST_RESULT_LIMITS.tests
    || new Set(binaries.map(binary => binary.path)).size !== binaries.length) fail();
  const tests: TestRow[] = [];
  let exitCode = 0;
  const runIgnored = testArgs.some(arg => arg === '--ignored' || arg === '--include-ignored');
  for (const binary of binaries) {
    const listed = await capture(binary.path,['--list','--format=terse',...testArgs],false);
    if (listed.code !== 0) fail();
    const names = rustTestCensus(listed.output);
    let ignored = new Set<string>();
    if (!runIgnored) {
      const skipped = await capture(binary.path,['--list','--format=terse','--ignored',...testArgs],false);
      if (skipped.code !== 0) fail();
      ignored = new Set(rustTestCensus(skipped.output));
      if ([...ignored].some(name => !names.includes(name))) fail();
    }
    const executed = await capture(binary.path,['--format=pretty','--color=never',...testArgs],true);
    const rows = rustTestResults(executed.output,names,ignored,executed.code,ctx);
    if (tests.length+rows.length > LOCAL_TEST_RESULT_LIMITS.tests) fail();
    for (const row of rows) tests.push({ ...row,id:`rust-${tests.length+1}`,name:safeText(binary.label+'/'+row.name,1024,ctx) });
    if (executed.code !== 0) exitCode = executed.code;
  }
  const encoded = JSON.stringify({ schema:'blinkhost.local-test-results/v1',run_id:ctx.runId,
    check_id:ctx.checkId,profile:'native',runner:`rust:libtest/${version.split(' ')[1]}`,tests,
    coverage:{ status:'not_collected' } });
  if (Buffer.byteLength(encoded) > LOCAL_TEST_RESULT_LIMITS.bytes) fail();
  const file = await open(ctx.path,'wx',0o600);
  try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRustTests(process.argv.slice(2)).then(code => { process.exitCode = code; },() => {
    process.stderr.write('The BlinkHost Rust test runner failed; no passing result was certified.\n');
    process.exitCode = 2;
  });
}
