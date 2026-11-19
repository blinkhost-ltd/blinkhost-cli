import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CliError } from '../errors.js';
import { LocalTestChecksFailure, LocalTestCommandFailure } from '../local-test-command.js';
import { LOCAL_TEST_CONFIG } from '../local-test-config.js';
import { createLocalTestResultSink, readLocalTestResults, removeLocalTestResultSink, LOCAL_TEST_RESULT_LIMITS } from '../local-test-results.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { localProjectCheckMessage, testProject } from '../workflows.js';
async function sinkFixture(t) {
    const sink = await createLocalTestResultSink();
    t.after(() => removeLocalTestResultSink(sink));
    return sink;
}
function canonical(sink, changes = {}) {
    return { schema: 'blinkhost.local-test-results/v1', run_id: sink.runId, check_id: 'unit', runner: 'fixture-runner/1',
        profile: 'native', tests: [{ id: 'one', name: 'one', status: 'passed' }], ...changes };
}
const identity = { id: 'unit', profile: 'native' };
async function project(t) {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-reported-checks-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'project');
    const scaffold = createScaffold({ name: 'checks', framework: 'html', packageManager: 'npm', modules: [
            { name: 'api', language: 'rust' }, { name: 'worker', language: 'python' },
        ] });
    await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
    return root;
}
function runner(tests, changes = {}, exitCode = 0) {
    return `const fs=require('node:fs'); const env=process.env;
    const report={schema:'blinkhost.local-test-results/v1',run_id:env.BLINKHOST_TEST_RUN_ID,
      check_id:env.BLINKHOST_TEST_CHECK_ID,profile:env.BLINKHOST_TEST_PROFILE,runner:'fixture-runner/1',
      tests:${JSON.stringify(tests)},...${JSON.stringify(changes)}};
    fs.writeFileSync(env.BLINKHOST_TEST_RESULT_PATH,JSON.stringify(report));process.exit(${exitCode});`;
}
function check(id, code, extra = {}) {
    return { id, target: 'project', command: process.execPath, args: ['-e', code.replaceAll('\n', ' ')], kind: 'test', profile: 'native',
        results: { format: 'blinkhost/v1' }, ...extra };
}
async function configure(root, checks) {
    await writeFile(join(root, LOCAL_TEST_CONFIG), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks }));
}
function failCode(code) {
    return error => error instanceof CliError && error.code === code;
}
test('structured customer counts and coverage remain runner-reported and profile-specific', async (t) => {
    const root = await project(t);
    await configure(root, [
        check('unit', runner([{ id: 'one', name: 'unit', status: 'passed', duration_ms: 4 },
            { id: 'skip', name: 'not selected', status: 'skipped' }], { coverage: { status: 'collected', metrics: { lines: { covered: 8, total: 10 }, branches: { covered: 0, total: 0 } } } }), { target: 'module:api' }),
        check('integration', runner([{ id: 'one', name: 'integration', status: 'passed' }], { coverage: { status: 'unavailable' } }), { target: 'module:worker', kind: 'integration', profile: 'wasm' }),
    ]);
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    assert.equal(result.tests_executed, 2);
    assert.deepEqual(result.test_counts, { total: 3, passed: 2, failed: 0, skipped: 1, unsupported: 0 });
    assert.equal(result.test_evidence, 'customer_runner_reported');
    assert.deepEqual(result.coverage, { native: 'customer_runner_reported', wasm: 'not_collected' });
    assert.equal(result.checks[0].report.coverage.authority, 'customer_runner_reported');
    assert.equal(result.checks[1].report.coverage.profile, 'wasm');
    assert.equal(result.checks[1].report.coverage.status, 'unavailable');
    assert.ok(result.backend_modules.every(row => row.status === 'tests_passed'));
    assert.match(localProjectCheckMessage(result), /2 passed, 0 failed, 1 skipped/);
});
for (const [status, tests] of [
    ['no_tests', []], ['skipped', [{ id: 'one', name: 'one', status: 'skipped' }]],
    ['unsupported', [{ id: 'one', name: 'one', status: 'unsupported' }]],
]) {
    test(`structured ${status} never claims executed tests or a tested module`, async (t) => {
        const root = await project(t);
        await configure(root, [check('unit', runner([...tests]), { target: 'module:api' })]);
        const result = await testProject([root]);
        assert.equal(result.status, status);
        assert.equal(result.tests_executed, 0);
        assert.equal(result.backend_modules[0].status, status);
        assert.match(localProjectCheckMessage(result), /2 backend module\(s\) were not tested/);
    });
}
test('structured and unstructured commands keep aggregate counts unknown', async (t) => {
    const root = await project(t);
    await configure(root, [check('unit', runner([{ id: 'one', name: 'one', status: 'passed' }])),
        check('unknown', 'process.exit(0)', { results: undefined })]);
    const result = await testProject([root]);
    assert.equal(result.test_evidence, 'mixed');
    assert.equal(result.tests_executed, null);
    assert.equal(result.test_counts, undefined);
});
test('reported failures override a zero command exit and leave trailing modules unrun', async (t) => {
    const root = await project(t);
    await configure(root, [check('fail', runner([{ id: 'one', name: 'one', status: 'failed',
                message: 'token=fixture-secret', stack: 'Bearer fixture-auth\nline 2' }]), { target: 'module:api' }),
        check('pending', "require('node:fs').writeFileSync('unexpected','yes')", { target: 'module:worker' })]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestChecksFailure);
        assert.equal(error.code, 'project_test_results_failed');
        const result = error.projectChecks;
        assert.equal(result.checks[0].execution.exit_code, 0);
        assert.equal(result.checks[0].report.counts.failed, 1);
        assert.equal(result.checks[1].status, 'not_run');
        assert.deepEqual(result.backend_modules.map(row => row.status), ['failed', 'not_run']);
        assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-auth/);
        return true;
    });
    await assert.rejects(access(join(root, '_server_islands/worker/unexpected')));
});
test('a nonzero command exit remains the primary failure even when its report claims success', async (t) => {
    const root = await project(t);
    await configure(root, [check('unit', runner([{ id: 'one', name: 'one', status: 'passed' }], {}, 7))]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.code, 'project_test_failed');
        assert.equal(error.execution.exit_code, 7);
        assert.equal(error.projectChecks.checks[0].report.status, 'passed');
        return true;
    });
});
test('missing required results cannot turn command success into test success', async (t) => {
    const root = await project(t);
    await configure(root, [check('unit', 'process.exit(0)')]);
    await assert.rejects(testProject([root]), failCode('missing_local_test_results'));
});
test('fresh run identities reject replay across sequential checks', async (t) => {
    const root = await project(t);
    await configure(root, [check('first', runner([{ id: 'one', name: 'one', status: 'passed' }]).replace('process.exit(0);', "fs.copyFileSync(env.BLINKHOST_TEST_RESULT_PATH,'old-result.json');")),
        check('replay', "require('node:fs').copyFileSync('old-result.json',process.env.BLINKHOST_TEST_RESULT_PATH)")]);
    await assert.rejects(testProject([root]), failCode('invalid_local_test_results'));
    // Customer-owned copies are preserved; only the temporary sink is cleaned.
    await access(join(root, 'old-result.json'));
});
test('run context and common credentials are screened in reports and command output; sink cleanup is owned', async (t) => {
    const root = await project(t);
    const code = `const fs=require('node:fs'),e=process.env;
    fs.writeFileSync('sink-path.txt',e.BLINKHOST_TEST_RESULT_PATH);
    console.log(e.BLINKHOST_TEST_RUN_ID,e.BLINKHOST_TEST_RESULT_PATH);
    fs.writeFileSync(e.BLINKHOST_TEST_RESULT_PATH,JSON.stringify({schema:'blinkhost.local-test-results/v1',
      run_id:e.BLINKHOST_TEST_RUN_ID,check_id:e.BLINKHOST_TEST_CHECK_ID,profile:e.BLINKHOST_TEST_PROFILE,
      runner:'fixture-runner/1',tests:[{id:'one',name:String.fromCharCode(27)+'[31mBearer fixture-auth',status:'passed',
      message:e.BLINKHOST_TEST_RUN_ID+' '+e.BLINKHOST_TEST_RESULT_PATH+' password=fixture-secret'}]}));`;
    await configure(root, [check('unit', code)]);
    const result = await testProject([root]);
    const path = await readFile(join(root, 'sink-path.txt'), 'utf8');
    assert.ok(!JSON.stringify(result).includes(path));
    assert.doesNotMatch(JSON.stringify(result), /fixture-auth|fixture-secret|\\u001b|blinkhost-test-result-/);
    await assert.rejects(access(path));
});
test('structured configuration rejects unsupported formats and build-result claims before commands run', async (t) => {
    const root = await project(t);
    for (const extra of [{ results: { format: 'guess' } }, { results: { format: 'blinkhost/v1', path: '../outside' } }, { kind: 'build' }]) {
        await configure(root, [check('unit', "require('node:fs').writeFileSync('unexpected','yes')", extra)]);
        await assert.rejects(testProject([root]), failCode('invalid_local_test_config'));
    }
    await assert.rejects(access(join(root, 'unexpected')));
});
test('structured success survives later builds and skipped checks for the same module', async (t) => {
    const root = await project(t);
    await configure(root, [check('unit', runner([{ id: 'one', name: 'one', status: 'passed' }]), { target: 'module:api' }),
        check('build', 'process.exit(0)', { target: 'module:api', kind: 'build', results: undefined }),
        check('skip', runner([{ id: 'one', name: 'one', status: 'skipped' }]), { target: 'module:api' })]);
    assert.equal((await testProject([root])).backend_modules[0].status, 'tests_passed');
});
for (const cancelled of [false, true]) {
    test(`structured ${cancelled ? 'cancellation' : 'timeout'} retains execution evidence and removes only its temporary sink`, async (t) => {
        const root = await project(t);
        await configure(root, [check('unit', "require('node:fs').writeFileSync('sink-path.txt',process.env.BLINKHOST_TEST_RESULT_PATH);setInterval(()=>{},1000)"),
            check('pending', "require('node:fs').writeFileSync('unexpected','yes')")]);
        const controller = new AbortController();
        const run = testProject([root, '--timeout', cancelled ? '5' : '1'], false, controller.signal);
        const rejection = assert.rejects(run, (error) => {
            assert.ok(error instanceof LocalTestCommandFailure);
            assert.equal(error.code, cancelled ? 'project_test_cancelled' : 'project_test_timeout');
            assert.equal(error.execution.status, cancelled ? 'cancelled' : 'timed_out');
            const checks = error.projectChecks.checks;
            assert.equal(checks[0].report, undefined);
            assert.equal(checks[1].status, 'not_run');
            return true;
        });
        if (cancelled) {
            const deadline = performance.now() + 3000;
            while (await access(join(root, 'sink-path.txt')).then(() => false, () => true)) {
                assert.ok(performance.now() < deadline, 'configured command did not start');
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            controller.abort('SIGTERM');
        }
        await rejection;
        const path = await readFile(join(root, 'sink-path.txt'), 'utf8');
        await assert.rejects(access(path));
        await assert.rejects(access(join(root, 'unexpected')));
    });
}
test('replacement result directories are rejected and not removed as harness-owned resources', async (t) => {
    const sink = await sinkFixture(t);
    const original = sink.directory + '-original';
    await rename(sink.directory, original);
    t.after(() => rm(original, { recursive: true, force: true }));
    await mkdir(sink.directory);
    t.after(() => rm(sink.directory, { recursive: true, force: true }));
    await writeFile(sink.path, JSON.stringify(canonical(sink)));
    await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    await removeLocalTestResultSink(sink);
    await access(sink.path);
});
for (const [name, changes] of [
    ['wrong nonce', { run_id: 'previous-run' }], ['wrong check', { check_id: 'other' }], ['wrong profile', { profile: 'wasm' }],
    ['unknown field', { secret: 'fixture-secret' }], ['wrong schema', { schema: 'guess' }],
    ['duplicate tests', { tests: [{ id: 'one', name: 'one', status: 'passed' }, { id: 'one', name: 'one', status: 'passed' }] }],
    ['invented status', { tests: [{ id: 'one', name: 'one', status: 'success' }] }],
    ['negative duration', { tests: [{ id: 'one', name: 'one', status: 'passed', duration_ms: -1 }] }],
    ['extra test fields', { tests: [{ id: 'one', name: 'one', status: 'passed', raw_body: 'fixture-secret' }] }],
    ['overlong stack', { tests: [{ id: 'one', name: 'one', status: 'failed', stack: 'x'.repeat(16_385) }] }],
    ['overlong multibyte label', { tests: [{ id: 'one', name: '\u00e9'.repeat(513), status: 'passed' }] }],
    ['overclaimed coverage', { coverage: { status: 'collected', metrics: { lines: { covered: 11, total: 10 } } } }],
    ['fractional coverage', { coverage: { status: 'collected', metrics: { lines: { covered: 0.5, total: 10 } } } }],
    ['unknown coverage metrics', { coverage: { status: 'collected', metrics: { bytes: { covered: 1, total: 1 } } } }],
    ['empty coverage', { coverage: { status: 'collected', metrics: {} } }],
    ['unavailable coverage with metrics', { coverage: { status: 'unavailable', metrics: { lines: { covered: 1, total: 1 } } } }],
    ['coverage without executed tests', { tests: [], coverage: { status: 'collected', metrics: { lines: { covered: 1, total: 1 } } } }],
]) {
    test(`result import rejects ${name} without reflecting untrusted bytes`, async (t) => {
        const sink = await sinkFixture(t);
        await writeFile(sink.path, JSON.stringify(canonical(sink, changes)));
        await assert.rejects(readLocalTestResults(sink, identity), (error) => {
            assert.ok(error instanceof CliError);
            assert.equal(error.code, 'invalid_local_test_results');
            assert.doesNotMatch(error.message, /fixture-secret|previous-run|results\.json/);
            return true;
        });
    });
}
test('file import enforces byte and test bounds and strict UTF-8', async (t) => {
    const sink = await sinkFixture(t);
    for (const content of [Buffer.alloc(LOCAL_TEST_RESULT_LIMITS.bytes + 1), Buffer.from([0xff, 0xfe]),
        JSON.stringify(canonical(sink, { tests: Array.from({ length: 10_001 }, (_, i) => ({ id: String(i), name: 't', status: 'passed' })) }))]) {
        await writeFile(sink.path, content);
        await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    }
    await writeFile(sink.path, JSON.stringify(canonical(sink)));
    await assert.rejects(readLocalTestResults(sink, identity, 10), failCode('invalid_local_test_results'));
});
test('result importer rejects symlinks, hardlinks, directories and nonblocking FIFO inputs', async (t) => {
    const sink = await sinkFixture(t);
    const source = join(sink.directory, 'original.json');
    await writeFile(source, JSON.stringify(canonical(sink)));
    await symlink(source, sink.path);
    await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    await rm(sink.path);
    await link(source, sink.path);
    await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    await rm(sink.path);
    await mkdir(sink.path);
    await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    await rm(sink.path, { recursive: true });
    if (process.platform === 'linux') {
        assert.equal(spawnSync('mkfifo', [sink.path]).status, 0);
        await assert.rejects(readLocalTestResults(sink, identity), failCode('invalid_local_test_results'));
    }
});
test('shared report byte budget stops subsequent checks without reading unbounded results', async (t) => {
    const root = await project(t);
    const code = runner([]).replace('tests:[],', "tests:Array.from({length:55},(_,i)=>({id:String(i),name:'test',status:'passed',stack:'x'.repeat(16000)})),");
    await configure(root, Array.from({ length: 6 }, (_, i) => check('unit' + i, code)));
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestChecksFailure);
        assert.equal(error.code, 'invalid_local_test_results');
        const checks = error.projectChecks.checks;
        assert.equal(checks.filter(row => row.report).length, 4);
        assert.equal(checks[4].report_error, 'invalid_local_test_results');
        assert.equal(checks[5].status, 'not_run');
        return true;
    });
});
//# sourceMappingURL=local-test-results.test.js.map