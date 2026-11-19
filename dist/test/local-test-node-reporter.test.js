import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LocalTestCommandFailure } from '../local-test-command.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { testProject } from '../workflows.js';
import reporter from '../local-test-node-reporter.js';
async function fixture(t, sources, options = {}) {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-node-reporter-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'project');
    const scaffold = createScaffold({ name: 'checks', framework: 'html', packageManager: 'npm', modules: [] });
    await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
    const files = [];
    for (let i = 0; i < sources.length; i++) {
        const file = 'suite-' + i + '.test.mjs';
        await writeFile(join(root, file), sources[i]);
        files.push(file);
    }
    await writeFile(join(root, 'blinkhost.tests.json'), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks: [{
                id: 'node-unit', target: 'project', command: process.execPath, args: ['--test',
                    '--test-reporter=' + resolve('dist/local-test-node-reporter.js'), ...(options.coverage ? ['--experimental-test-coverage'] : []), ...files],
                kind: 'test', profile: options.profile ?? 'native', results: { format: 'blinkhost/v1' },
            }] }));
    return root;
}
test('real node:test events reconcile nested tests, suites, multiple files, skip and todo counts', async (t) => {
    const root = await fixture(t, [
        "import {describe,test} from 'node:test'; describe('team',()=>{test('pass',()=>{});test.skip('skip',()=>{});test.todo('todo')});test('nested',async t=>{await t.test('child',()=>{})});test('expected failure',{todo:true},()=>{throw new Error('fixture')});",
        "import {test} from 'node:test';test('pass',()=>{})",
    ]);
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    assert.deepEqual(result.test_counts, { total: 7, passed: 4, failed: 0, skipped: 3, unsupported: 0 });
    assert.equal(result.tests_executed, 4);
    assert.equal(result.checks[0].report.runner, `node:test/${process.version}`);
    assert.equal(new Set(result.checks[0].report.tests.map(row => row.id)).size, 7);
    assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
});
test('actual Node coverage totals stay native and use integer covered/total metrics', async (t) => {
    const root = await fixture(t, ["import {test} from 'node:test'; import assert from 'node:assert/strict'; function doubled(value){return value*2} test('function',()=>assert.equal(doubled(3),6));"], { coverage: true });
    const result = await testProject([root]);
    const coverage = result.checks[0].report.coverage;
    assert.equal(coverage.status, 'collected');
    assert.equal(coverage.profile, 'native');
    assert.deepEqual(result.coverage, { native: 'customer_runner_reported', wasm: 'not_collected' });
    for (const key of ['lines', 'branches', 'functions']) {
        const metric = coverage.metrics[key];
        assert.ok(Number.isSafeInteger(metric.covered) && Number.isSafeInteger(metric.total));
        assert.ok(metric.total > 0 && metric.covered <= metric.total);
    }
});
test('real Node failures preserve runner counts and sanitize error details with nonzero process exit', async (t) => {
    const root = await fixture(t, ["import {test} from 'node:test';test('fails',()=>{throw new Error('password=fixture-secret Bearer fixture-auth')})"]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.code, 'project_test_failed');
        assert.equal(error.execution.exit_code, 1);
        const report = error.projectChecks.checks[0].report;
        assert.deepEqual(report.counts, { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 });
        assert.equal(report.status, 'failed');
        assert.doesNotMatch(JSON.stringify(error.projectChecks), /fixture-secret|fixture-auth/);
        return true;
    });
});
test('customer Node stdout and stderr reach bounded CLI diagnostics with credential screening', async (t) => {
    const root = await fixture(t, ["import {test} from 'node:test';test('logs',()=>{process.stdout.write('customer-info password=fixture-secret\\n');process.stderr.write('customer-error Bearer fixture-auth\\n')})"]);
    const result = await testProject([root]);
    const execution = result.checks[0].execution;
    assert.equal(result.tests_executed, 1);
    assert.match(execution.output.stdout, /customer-info password=\[REDACTED\]/);
    assert.match(execution.output.stdout, /customer-error Bearer \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-auth/);
});
test('actual Node test stdout and stderr each consume the shared output budget', async (t) => {
    for (const stream of ['stdout', 'stderr']) {
        const root = await fixture(t, ["import {test} from 'node:test';test('large output',()=>{process." + stream + ".write('x'.repeat(4096))})"]);
        await assert.rejects(testProject([root, '--max-output-bytes', '1024']), error => {
            assert.ok(error instanceof LocalTestCommandFailure);
            assert.equal(error.code, 'project_test_output_limit');
            assert.equal(error.execution.status, 'output_limit');
            assert.ok(error.execution.observed_output_bytes > 1024);
            assert.ok(error.execution.captured_output_bytes <= 1024);
            assert.equal(error.projectChecks.checks[0].report, undefined);
            return true;
        });
    }
});
test('Node empty and skipped-only suites do not claim tests or collected coverage', async (t) => {
    for (const [source, expected] of [['export const value=1;', 'no_tests'],
        ["import {test} from 'node:test';test.skip('skip',()=>{})", 'skipped']]) {
        const root = await fixture(t, [source], { coverage: true });
        const result = await testProject([root]);
        assert.equal(result.status, expected);
        assert.equal(result.tests_executed, 0);
        assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
    }
});
test('empty files do not inflate actual application counts in a mixed Node run', async (t) => {
    const root = await fixture(t, ['export const value=1;', "import {test} from 'node:test';test('one',()=>{})", '']);
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    assert.equal(result.tests_executed, 1);
    assert.deepEqual(result.test_counts, { total: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0 });
});
test('a declared Node test named after its file remains an application test', async (t) => {
    const root = await fixture(t, ["import {test} from 'node:test';import {fileURLToPath} from 'node:url';test(fileURLToPath(import.meta.url),()=>{})"]);
    const result = await testProject([root]);
    assert.equal(result.tests_executed, 1);
    assert.equal(result.test_counts.passed, 1);
});
test('a Node file-load failure remains a failed command with zero declared tests', async (t) => {
    const root = await fixture(t, ["throw new Error('fixture loading failure')"]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.execution.exit_code, 1);
        const check = error.projectChecks.checks[0];
        assert.equal(check.report_error, undefined);
        assert.equal(check.report.counts.total, 0);
        assert.equal(check.report.status, 'no_tests');
        return true;
    });
});
test('Node suite hook failure remains a nonzero check with cancelled child failures', async (t) => {
    const root = await fixture(t, ["import {describe,test,before} from 'node:test';describe('suite',()=>{before(()=>{throw new Error('fixture hook')});test('one',()=>{});test('two',()=>{})})"]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.execution.exit_code, 1);
        const check = error.projectChecks.checks[0];
        assert.equal(check.report_error, undefined);
        assert.equal(check.report.counts.failed, 2);
        return true;
    });
});
test('the Node adapter refuses to label native execution as WASM or browser testing', async (t) => {
    for (const profile of ['wasm', 'browser']) {
        const root = await fixture(t, ["import {test} from 'node:test';test('one',()=>{})"], { profile });
        await assert.rejects(testProject([root]), (error) => {
            assert.ok(error instanceof LocalTestCommandFailure);
            assert.notEqual(error.execution.exit_code, 0);
            const check = error.projectChecks.checks[0];
            assert.equal(check.report, undefined);
            assert.equal(check.report_error, 'missing_local_test_results');
            return true;
        });
    }
});
test('incomplete native runner event streams cannot produce a certified result', async () => {
    const previous = { path: process.env.BLINKHOST_TEST_RESULT_PATH, id: process.env.BLINKHOST_TEST_RUN_ID,
        check: process.env.BLINKHOST_TEST_CHECK_ID, profile: process.env.BLINKHOST_TEST_PROFILE };
    Object.assign(process.env, { BLINKHOST_TEST_RESULT_PATH: '/unused-result', BLINKHOST_TEST_RUN_ID: 'unused',
        BLINKHOST_TEST_CHECK_ID: 'unused', BLINKHOST_TEST_PROFILE: 'native' });
    try {
        async function* source() { yield { type: 'test:pass', data: { name: 'one', details: { duration_ms: 1, type: 'test' } } }; }
        await assert.rejects(async () => { for await (const _ of reporter(source())) { /* drain */ } }, /could not qualify/);
    }
    finally {
        for (const [key, value] of [['BLINKHOST_TEST_RESULT_PATH', previous.path], ['BLINKHOST_TEST_RUN_ID', previous.id],
            ['BLINKHOST_TEST_CHECK_ID', previous.check], ['BLINKHOST_TEST_PROFILE', previous.profile]]) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
});
//# sourceMappingURL=local-test-node-reporter.test.js.map