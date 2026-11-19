import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoTestEvents } from '../local-test-go-runner.js';
import { runLocalTestCommand, LocalTestCommandFailure } from '../local-test-command.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { testProject } from '../workflows.js';
const adapter = resolve('dist/local-test-go-runner.js');
async function fixture(t, source, options = {}) {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-go-runner-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'project');
    const scaffold = createScaffold({ name: 'checks', framework: 'html', packageManager: 'npm', modules: [] });
    await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
    await writeFile(join(root, 'go.mod'), 'module example.invalid/customer\n\ngo 1.26\n');
    await writeFile(join(root, 'app_test.go'), source);
    await writeFile(join(root, 'blinkhost.tests.json'), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks: [{
                id: 'go-unit', target: 'project', command: process.execPath, args: [adapter, ...(options.args ?? ['-count=1', './...'])],
                kind: 'test', profile: options.profile ?? 'native', results: { format: 'blinkhost/v1' },
            }] }));
    return root;
}
function failedCheck(error, code = 'project_test_failed') {
    assert.ok(error instanceof LocalTestCommandFailure);
    assert.equal(error.code, code);
    return error.projectChecks.checks[0];
}
test('actual Go tests report parent cases, subtests, parallel cases and skips across packages', async (t) => {
    const root = await fixture(t, `package customer
import "testing"
func TestPass(t *testing.T) { if 3 * 2 != 6 { t.Fatal("bad sum") } }
func TestNested(t *testing.T) {
  t.Run("pass", func(t *testing.T) { t.Parallel() })
  t.Run("skip", func(t *testing.T) { t.Skip("optional") })
}
func TestParallel(t *testing.T) { t.Parallel() }
`);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'nested_test.go'), 'package nested\nimport "testing"\nfunc TestOther(t *testing.T) {}\n');
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    assert.deepEqual(result.test_counts, { total: 6, passed: 5, failed: 0, skipped: 1, unsupported: 0 });
    assert.equal(result.tests_executed, 5);
    assert.equal(new Set(result.checks[0].report.tests.map(row => row.id)).size, 6);
    assert.match(result.checks[0].report.runner, /^go:test\/go1\./);
    assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
});
test('Go assertion failures and failed subtests retain nonzero exits and sanitized diagnostics', async (t) => {
    const root = await fixture(t, `package customer
import ("testing"; "os")
func TestFail(t *testing.T) { t.Fatal("password=fixture-secret Bearer fixture-auth", os.Getenv("BLINKHOST_TEST_RUN_ID")) }
func TestNested(t *testing.T) { t.Run("fail", func(t *testing.T) { t.Fatal("nested fixture") }) }
func TestPass(t *testing.T) {}
`);
    await assert.rejects(testProject([root]), (error) => {
        const check = failedCheck(error);
        assert.equal(check.execution.exit_code, 1);
        assert.deepEqual(check.report.counts, { total: 4, passed: 1, failed: 3, skipped: 0, unsupported: 0 });
        assert.doesNotMatch(JSON.stringify(error), /fixture-secret|fixture-auth/);
        assert.match(check.report.tests.find(row => row.name.endsWith('/TestFail')).message, /LOCAL TEST CONTEXT/);
        return true;
    });
});
test('empty and skipped-only Go packages never claim executed application tests', async (t) => {
    for (const [source, status, skipped] of [
        ['package customer\n', 'no_tests', 0],
        ['package customer\nimport "testing"\nfunc TestSkip(t *testing.T) { t.Skip("optional") }\n', 'skipped', 1],
    ]) {
        const result = await testProject([await fixture(t, source)]);
        assert.equal(result.status, status);
        assert.equal(result.tests_executed, 0);
        assert.deepEqual(result.test_counts, { total: skipped, passed: 0, failed: 0, skipped, unsupported: 0 });
    }
});
test('Go package build and TestMain failures cannot create passing test evidence', async (t) => {
    for (const source of [
        'package customer\nimport "testing"\nfunc TestBroken(t *testing.T) { undefinedFixture() }\n',
        'package customer\nimport ("testing"; "os")\nfunc TestMain(m *testing.M) { os.Exit(7) }\nfunc TestNever(t *testing.T) {}\n',
    ]) {
        await assert.rejects(testProject([await fixture(t, source)]), (error) => {
            const check = failedCheck(error);
            assert.notEqual(check.execution.exit_code, 0);
            assert.equal(check.report?.counts.total ?? 0, 0);
            return true;
        });
    }
});
test('Go test selection, repeated runs and failfast reach the actual native runner', async (t) => {
    const source = 'package customer\nimport "testing"\nfunc TestAFail(t *testing.T) { t.Fatal("fixture") }\nfunc TestBPass(t *testing.T) {}\n';
    const selected = await testProject([await fixture(t, source, { args: ['-count=2', '-run=TestBPass', '.'] })]);
    assert.deepEqual(selected.test_counts, { total: 2, passed: 2, failed: 0, skipped: 0, unsupported: 0 });
    assert.ok(selected.checks[0].report.tests.every(row => row.name.endsWith('/TestBPass')));
    await assert.rejects(testProject([await fixture(t, source, { args: ['-count=1', '-failfast', '.'] })]), (error) => {
        assert.deepEqual(failedCheck(error).report.counts, { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 });
        return true;
    });
});
test('Go native runner rejects WASM and browser profiles before customer code runs', async (t) => {
    for (const profile of ['wasm', 'browser']) {
        const root = await fixture(t, 'package customer\nimport ("testing"; "os")\nfunc TestTouched(t *testing.T) { os.WriteFile("touched", []byte("yes"), 0600) }\n', { profile });
        await assert.rejects(testProject([root]), (error) => {
            assert.equal(failedCheck(error).report, undefined);
            return true;
        });
        await assert.rejects(access(join(root, 'touched')));
    }
});
test('Go runner refuses missing context and existing result files without overwriting', async (t) => {
    const root = await fixture(t, 'package customer\nimport "testing"\nfunc TestPass(t *testing.T) {}\n');
    const env = { ...process.env };
    for (const key of Object.keys(env))
        if (key.startsWith('BLINKHOST_TEST_'))
            delete env[key];
    const missing = await runLocalTestCommand(process.execPath, [adapter, '.'], { cwd: root, env });
    assert.equal(missing.exit_code, 2);
    const path = join(root, 'existing.json');
    await writeFile(path, 'preserved');
    const existing = await runLocalTestCommand(process.execPath, [adapter, '-count=1', '.'], { cwd: root, env: { ...env,
            BLINKHOST_TEST_RESULT_PATH: path, BLINKHOST_TEST_RUN_ID: randomUUID(), BLINKHOST_TEST_CHECK_ID: 'go-unit', BLINKHOST_TEST_PROFILE: 'native' } });
    assert.equal(existing.exit_code, 2);
    assert.equal(await readFile(path, 'utf8'), 'preserved');
});
test('Go successful reports use private permissions and honest native coverage', async (t) => {
    const root = await fixture(t, 'package customer\nimport "testing"\nfunc TestPass(t *testing.T) {}\n');
    const path = join(root, 'fresh.json');
    const run = await runLocalTestCommand(process.execPath, [adapter, '-count=1', '-cover', '.'], { cwd: root, env: { ...process.env,
            BLINKHOST_TEST_RESULT_PATH: path, BLINKHOST_TEST_RUN_ID: randomUUID(), BLINKHOST_TEST_CHECK_ID: 'go-unit', BLINKHOST_TEST_PROFILE: 'native' } });
    assert.equal(run.exit_code, 0);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).coverage, { status: 'not_collected' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
});
test('Go timeout and output budgets terminate the actual customer runner', async (t) => {
    const slow = await fixture(t, 'package customer\nimport ("testing"; "time")\nfunc TestSlow(t *testing.T) { time.Sleep(10*time.Second) }\n');
    await assert.rejects(testProject([slow, '--timeout', '1']), (error) => {
        assert.equal(failedCheck(error, 'project_test_timeout').status, 'timed_out');
        return true;
    });
    const noisy = await fixture(t, 'package customer\nimport ("testing"; "fmt"; "strings")\nfunc TestNoise(t *testing.T) { fmt.Print(strings.Repeat("x", 100000)) }\n');
    await assert.rejects(testProject([noisy, '--max-output-bytes', '4096']), (error) => {
        assert.equal(failedCheck(error, 'project_test_output_limit').status, 'output_limit');
        return true;
    });
});
test('Go cancellation and panics never certify interrupted tests as passed', async (t) => {
    const panic = await fixture(t, 'package customer\nimport "testing"\nfunc TestPanic(t *testing.T) { panic("fixture panic") }\n');
    await assert.rejects(testProject([panic]), (error) => {
        const check = failedCheck(error);
        assert.notEqual(check.execution.exit_code, 0);
        assert.equal(check.report?.counts.passed ?? 0, 0);
        return true;
    });
    const root = await fixture(t, 'package customer\nimport ("testing"; "time")\nfunc TestSlow(t *testing.T) { time.Sleep(10*time.Second) }\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('SIGINT'), 300);
    try {
        await assert.rejects(testProject([root], false, controller.signal), (error) => {
            assert.equal(failedCheck(error, 'project_test_cancelled').status, 'cancelled');
            return true;
        });
    }
    finally {
        clearTimeout(timer);
    }
});
test('Go non-test modes are rejected before customer test code executes', async (t) => {
    for (const option of ['-c', '--c', '-list=.', '--list=.', '-bench=.', '-test.bench=.', '-fuzz=FuzzOne', '-json=false', '--json=false', '-exec=other', '-args']) {
        const root = await fixture(t, 'package customer\nimport ("testing"; "os")\nfunc TestTouched(t *testing.T) { os.WriteFile("touched", []byte("yes"), 0600) }\n', { args: [option] });
        await assert.rejects(testProject([root]));
        await assert.rejects(access(join(root, 'touched')));
    }
});
test('Go inherited mode flags and cross-compilation cannot silently change native test evidence', async (t) => {
    const root = await fixture(t, 'package customer\nimport ("testing"; "os")\nfunc TestTouched(t *testing.T) { os.WriteFile("touched", []byte("yes"), 0600) }\n');
    const path = join(root, 'fresh.json');
    const env = { ...process.env, BLINKHOST_TEST_RESULT_PATH: path, BLINKHOST_TEST_RUN_ID: randomUUID(),
        BLINKHOST_TEST_CHECK_ID: 'go-unit', BLINKHOST_TEST_PROFILE: 'native' };
    const cross = await runLocalTestCommand(process.execPath, [adapter, '-count=1', '.'], { cwd: root,
        env: { ...env, GOOS: 'wasip1', GOARCH: 'wasm' } });
    assert.equal(cross.exit_code, 2);
    await assert.rejects(access(join(root, 'touched')));
    await assert.rejects(access(path));
    const inherited = await runLocalTestCommand(process.execPath, [adapter, '-count=1', '.'], { cwd: root,
        env: { ...env, GOFLAGS: '-json=false -run=TestNever' } });
    assert.equal(inherited.exit_code, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).tests.length, 1);
    assert.equal(await readFile(join(root, 'touched'), 'utf8'), 'yes');
});
test('Go event reconciliation rejects malformed, incomplete and contradictory runner streams', () => {
    const ctx = { path: '/tmp/results.json', runId: 'fixture-run', checkId: 'go-unit' };
    for (const events of [
        [{ Action: 'run', Package: 'customer', Test: 'TestOne' }],
        [{ Action: 'start', Package: 'customer' }, { Action: 'pass', Package: 'customer', Test: 'TestOne' }],
        [{ Action: 'start', Package: 'customer' }, { Action: 'run', Package: 'customer', Test: 'TestOne' }],
        [{ Action: 'start', Package: 'customer' }, { Action: 'run', Package: 'customer', Test: 'TestOne' }, { Action: 'pass', Package: 'customer', Test: 'TestOne', Elapsed: -1 }],
        [{ Action: 'start', Package: 'customer' }, { Action: 'fail', Package: 'customer' }],
    ]) {
        assert.throws(() => { const collector = new GoTestEvents(ctx); events.forEach(event => collector.accept(event)); collector.finish(0); });
    }
    const collector = new GoTestEvents(ctx);
    collector.accept({ Action: 'start', Package: 'customer' });
    for (let i = 0; i < 10000; i++) {
        collector.accept({ Action: 'run', Package: 'customer', Test: `Test${i}` });
        collector.accept({ Action: 'pass', Package: 'customer', Test: `Test${i}` });
    }
    assert.throws(() => collector.accept({ Action: 'run', Package: 'customer', Test: 'TestOverflow' }));
});
test('Go setup failures have no test report while completed tests survive a later package failure', () => {
    const ctx = { path: '/tmp/results.json', runId: 'fixture-run', checkId: 'go-unit' };
    for (const buildFailed of [false, true]) {
        const collector = new GoTestEvents(ctx);
        if (buildFailed)
            collector.accept({ Action: 'build-fail', ImportPath: 'customer' });
        collector.accept({ Action: 'start', Package: 'customer' });
        collector.accept({ Action: 'fail', Package: 'customer' });
        assert.throws(() => collector.finish(1));
    }
    const collector = new GoTestEvents(ctx);
    collector.accept({ Action: 'start', Package: 'customer' });
    collector.accept({ Action: 'run', Package: 'customer', Test: 'TestCompleted' });
    collector.accept({ Action: 'pass', Package: 'customer', Test: 'TestCompleted' });
    collector.accept({ Action: 'fail', Package: 'customer' });
    assert.equal(collector.finish(1).length, 1);
});
test('Go event diagnostics enforce bounds and screen before UTF-8 truncation', () => {
    const collector = new GoTestEvents({ path: '/tmp/results.json', runId: 'fixture-run', checkId: 'go-unit' });
    collector.accept({ Action: 'start', Package: 'customer' });
    collector.accept({ Action: 'run', Package: 'customer', Test: 'TestFail' });
    collector.accept({ Action: 'output', Package: 'customer', Test: 'TestFail', Output: '\u001b[31m' + 'é'.repeat(2040) + ' token=boundary-secret Bearer fixture-auth fixture-run' });
    collector.accept({ Action: 'fail', Package: 'customer', Test: 'TestFail' });
    collector.accept({ Action: 'fail', Package: 'customer' });
    const tests = collector.finish(1);
    assert.doesNotMatch(JSON.stringify(tests), /boundary-secret|fixture-auth|fixture-run|\u001b|�/);
    assert.ok(Buffer.byteLength(tests[0].message) <= 4096);
    const overflow = new GoTestEvents({ path: '/tmp/results.json', runId: 'run', checkId: 'check' });
    overflow.accept({ Action: 'start', Package: 'customer' });
    overflow.accept({ Action: 'run', Package: 'customer', Test: 'TestOne' });
    assert.throws(() => overflow.accept({ Action: 'output', Package: 'customer', Test: 'TestOne', Output: 'x'.repeat(65537) }));
});
//# sourceMappingURL=local-test-go-runner.test.js.map