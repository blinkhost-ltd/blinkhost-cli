import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runLocalTestCommand, LocalTestCommandFailure } from '../local-test-command.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { testProject } from '../workflows.js';
const adapter = resolve('test-runners/python-unittest.py');
const python = process.env.BLINKHOST_TEST_PYTHON ?? 'python3';
async function fixture(t, source, options = {}) {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-python-runner-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'project');
    const scaffold = createScaffold({ name: 'checks', framework: 'html', packageManager: 'npm', modules: [] });
    await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
    await writeFile(join(root, 'test_application.py'), source);
    await writeFile(join(root, 'blinkhost.tests.json'), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks: [{
                id: 'python-unit', target: 'project', command: python,
                args: [adapter, ...(options.args ?? ['discover', '-s', '.', '-p', 'test_*.py'])],
                kind: 'test', profile: options.profile ?? 'native', results: { format: 'blinkhost/v1' },
            }] }));
    return root;
}
function failedCheck(error, expected = 'project_test_failed') {
    assert.ok(error instanceof LocalTestCommandFailure);
    assert.equal(error.code, expected);
    return error.projectChecks.checks[0];
}
test('actual Python unittest discovery reports parent tests, skips and expected failures accurately', async (t) => {
    const root = await fixture(t, `import unittest
class Application(unittest.TestCase):
    def test_pass(self): self.assertEqual(3 * 2, 6)
    def test_subtests(self):
        for i in range(3):
            with self.subTest(i=i): self.assertGreaterEqual(i, 0)
    @unittest.skip('optional dependency')
    def test_skip(self): pass
    @unittest.expectedFailure
    def test_expected(self): self.assertTrue(False)
`);
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    assert.deepEqual(result.test_counts, { total: 4, passed: 2, failed: 0, skipped: 2, unsupported: 0 });
    assert.equal(result.tests_executed, 2);
    assert.match(result.checks[0].report.runner, /^python:unittest\/3\./);
    assert.equal(new Set(result.checks[0].report.tests.map(row => row.id)).size, 4);
    assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
});
test('optional Python coverage measures application lines, branches and unimported files', {
    skip: process.env.BLINKHOST_TEST_PYTHON_COVERAGE !== '1',
}, async (t) => {
    const root = await fixture(t, `import unittest
from app.logic import choose
class Application(unittest.TestCase):
    def test_positive(self): self.assertEqual(choose(2), 1)
`, { args: ['--coverage=app', 'discover', '-s', '.'] });
    await mkdir(join(root, 'app'));
    await writeFile(join(root, 'app/__init__.py'), '');
    await writeFile(join(root, 'app/logic.py'), 'def choose(value):\n    if value > 0:\n        return 1\n    return 0\n');
    await writeFile(join(root, 'app/unimported.py'), 'def unused():\n    return 9\n');
    // Optional coverage uses the explicit scope, ignoring ambient config/plugins.
    await writeFile(join(root, '.coveragerc'), '[run]\nplugins = missing_customer_plugin\n');
    const result = await testProject([root]);
    assert.equal(result.status, 'tests_passed');
    const coverage = result.checks[0].report.coverage;
    assert.deepEqual(coverage, { status: 'collected', profile: 'native', authority: 'customer_runner_reported',
        metrics: { lines: { covered: 3, total: 6 }, branches: { covered: 1, total: 2 } } });
    assert.deepEqual(result.coverage, { native: 'customer_runner_reported', wasm: 'not_collected' });
    await assert.rejects(access(join(root, '.coverage')));
    await assert.rejects(access(join(root, 'coverage.json')));
});
test('collected Python coverage preserves assertion failure and reports no invented function totals', {
    skip: process.env.BLINKHOST_TEST_PYTHON_COVERAGE !== '1',
}, async (t) => {
    const root = await fixture(t, 'import unittest\nclass Application(unittest.TestCase):\n    def test_failure(self): self.fail("intentional")\n', { args: ['--coverage', 'discover', '-s', '.'] });
    await assert.rejects(testProject([root]), (error) => {
        const check = failedCheck(error);
        assert.equal(check.execution.exit_code, 1);
        assert.equal(check.report.counts.failed, 1);
        assert.equal(check.report.coverage.status, 'collected');
        assert.equal(check.report.coverage.metrics?.functions, undefined);
        return true;
    });
});
test('requested Python coverage is unavailable for missing libraries and empty or skipped-only suites', async (t) => {
    for (const [source, missing, status] of [
        ['import unittest\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n', true, 'tests_passed'],
        ['value = 1\n', false, 'no_tests'],
        ['import unittest\n@unittest.skip("optional")\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n', false, 'skipped'],
    ]) {
        const root = await fixture(t, source, { args: ['--coverage', 'discover', '-s', '.'] });
        if (missing)
            await writeFile(join(root, 'coverage.py'), 'raise ImportError("optional library missing")\n');
        const result = await testProject([root]);
        assert.equal(result.status, status);
        assert.deepEqual(result.checks[0].report.coverage, { status: 'unavailable', profile: 'native', authority: 'customer_runner_reported' });
    }
});
test('Python coverage rejects invalid source scope before customer tests execute', async (t) => {
    for (const arg of ['--coverage=', '--coverage=..', '--coverage=/tmp', '--coverage=missing-directory']) {
        const root = await fixture(t, 'from pathlib import Path\nPath("executed.txt").write_text("bad")\n', { args: [arg, 'discover', '-s', '.'] });
        await assert.rejects(testProject([root]), (error) => {
            const check = failedCheck(error);
            assert.equal(check.execution.exit_code, 2);
            assert.equal(check.report_error, 'missing_local_test_results');
            return true;
        });
        await assert.rejects(access(join(root, 'executed.txt')));
    }
});
test('broken or oversized optional coverage never erases actual Python test results', async (t) => {
    for (const body of [
        '__version__ = "8.0.0"\n',
        '__version__ = "7.10.7"\nclass Coverage:\n    def __init__(self, **kwargs): raise RuntimeError("private failure")\n',
        '__version__ = "7.10.7"\nclass Coverage:\n    def __init__(self, **kwargs): pass\n    def start(self): pass\n    def stop(self): pass\n    def json_report(self, **kwargs): print("x" * 1048577)\n',
        '__version__ = "7.10.7"\nclass Coverage:\n    def __init__(self, **kwargs): pass\n    def start(self): pass\n    def stop(self): pass\n    def json_report(self, **kwargs): print(\'{"totals":{"covered_lines":true,"num_statements":1,"covered_branches":2,"num_branches":1}}\')\n',
    ]) {
        const root = await fixture(t, 'import unittest\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n', { args: ['--coverage', 'discover', '-s', '.'] });
        await writeFile(join(root, 'coverage.py'), body);
        const result = await testProject([root]);
        assert.equal(result.test_counts?.passed, 1);
        assert.equal(result.checks[0].report.coverage.status, 'unavailable');
        assert.doesNotMatch(JSON.stringify(result.checks[0].report), /private failure/);
    }
});
test('Python assertions, exceptions, failing subtests and unexpected successes remain failed checks', async (t) => {
    const root = await fixture(t, `import unittest, os
class Application(unittest.TestCase):
    def test_assertion(self): self.assertEqual(1, 2, 'password=fixture-secret Bearer fixture-auth')
    def test_error(self): raise RuntimeError(os.environ['BLINKHOST_TEST_RUN_ID'])
    def test_subtests(self):
        for i in range(3):
            with self.subTest(i=i): self.assertEqual(i, 0)
    @unittest.expectedFailure
    def test_unexpected(self): pass
    def test_pass(self): pass
`);
    await assert.rejects(testProject([root]), (error) => {
        const check = failedCheck(error);
        assert.equal(check.execution.exit_code, 1);
        assert.deepEqual(check.report.counts, { total: 5, passed: 1, failed: 4, skipped: 0, unsupported: 0 });
        assert.doesNotMatch(JSON.stringify(error), /fixture-secret|fixture-auth/);
        assert.match(check.report.tests.find(row => row.name.includes('test_error')).stack, /LOCAL TEST CONTEXT/);
        return true;
    });
});
test('empty and skipped-only Python discovery never claim executed tests', async (t) => {
    for (const [source, status, skipped] of [
        ['value = 1\n', 'no_tests', 0],
        ["import unittest\n@unittest.skip('optional')\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n    def test_two(self): pass\n", 'skipped', 2],
    ]) {
        const result = await testProject([await fixture(t, source)]);
        assert.equal(result.status, status);
        assert.equal(result.tests_executed, 0);
        assert.deepEqual(result.test_counts, { total: skipped, passed: 0, failed: 0, skipped, unsupported: 0 });
    }
});
test('skipped Python subtests do not inflate declared parent test counts', async (t) => {
    const root = await fixture(t, `import unittest
class Application(unittest.TestCase):
    def test_subtests(self):
        for i in range(3):
            with self.subTest(i=i):
                if i == 1: self.skipTest('optional subcase')
                self.assertGreaterEqual(i, 0)
`);
    const result = await testProject([root]);
    assert.deepEqual(result.test_counts, { total: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0 });
    assert.match(result.checks[0].report.tests[0].message, /Skipped subtest/);
});
test('a Python parent with only skipped subtests stays skipped', async (t) => {
    const root = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def test_subtests(self):\n        with self.subTest(optional=True): self.skipTest('optional')\n");
    const result = await testProject([root]);
    assert.equal(result.status, 'skipped');
    assert.equal(result.tests_executed, 0);
    assert.deepEqual(result.test_counts, { total: 1, passed: 0, failed: 0, skipped: 1, unsupported: 0 });
});
test('Python discovery and class/module fixture failures never invent successful test evidence', async (t) => {
    for (const source of [
        "raise RuntimeError('fixture collection error')\n",
        "import unittest\nclass Application(unittest.TestCase):\n    @classmethod\n    def setUpClass(cls): raise RuntimeError('fixture class error')\n    def test_one(self): pass\n",
        "import unittest\ndef setUpModule(): raise RuntimeError('fixture module error')\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n",
    ]) {
        await assert.rejects(testProject([await fixture(t, source)]), (error) => {
            const check = failedCheck(error);
            assert.notEqual(check.execution.exit_code, 0);
            assert.equal(check.report, undefined);
            assert.equal(check.report_error, 'missing_local_test_results');
            return true;
        });
    }
});
test('a Python test setup error retains one actual failed test record', async (t) => {
    const root = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def setUp(self): raise RuntimeError('fixture setup failure')\n    def test_one(self): pass\n");
    await assert.rejects(testProject([root]), (error) => {
        assert.deepEqual(failedCheck(error).report.counts, { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 });
        return true;
    });
});
test('Python result details screen credentials, terminal controls and multibyte truncation boundaries', async (t) => {
    const root = await fixture(t, `import unittest
class Application(unittest.TestCase):
    def test_failure(self):
        message = '\\x1b[31m' + 'é' * 2040 + ' token=boundary-secret https://user:fixture-pass@example.invalid Bearer fixture-auth'
        raise RuntimeError(message)
`);
    await assert.rejects(testProject([root]), (error) => {
        const report = failedCheck(error).report;
        assert.doesNotMatch(JSON.stringify(report), /boundary-secret|fixture-pass|fixture-auth|\\u001b|�/);
        assert.ok(Buffer.byteLength(report.tests[0].message) <= 4096);
        assert.ok(Buffer.byteLength(report.tests[0].stack) <= 16_384);
        return true;
    });
});
test('Python native runner rejects WASM/browser profiles before executing customer code', async (t) => {
    for (const profile of ['wasm', 'browser']) {
        const root = await fixture(t, "from pathlib import Path\nPath('executed.txt').write_text('bad')\n", { profile });
        await assert.rejects(testProject([root]), (error) => {
            const check = failedCheck(error);
            assert.equal(check.execution.exit_code, 2);
            assert.equal(check.report_error, 'missing_local_test_results');
            return true;
        });
        await assert.rejects(access(join(root, 'executed.txt')));
    }
});
test('Python native reporter refuses missing context and refuses to overwrite an existing result', async (t) => {
    const root = await fixture(t, 'value=1\n');
    const missing = await runLocalTestCommand(python, [adapter, 'discover', '-s', '.'], { cwd: root, env: {} });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.exit_code, 2);
    const path = join(root, 'existing-result.json');
    await writeFile(path, 'preserved');
    const existing = await runLocalTestCommand(python, [adapter, 'discover', '-s', '.'], {
        cwd: root, env: { ...process.env, BLINKHOST_TEST_RESULT_PATH: path, BLINKHOST_TEST_RUN_ID: randomUUID(),
            BLINKHOST_TEST_CHECK_ID: 'python-unit', BLINKHOST_TEST_PROFILE: 'native' },
    });
    assert.equal(existing.exit_code, 2);
    assert.equal(await readFile(path, 'utf8'), 'preserved');
});
test('Python check timeout and output budgets stop the actual customer runner', async (t) => {
    const sleeping = await fixture(t, "import unittest,time\nclass Application(unittest.TestCase):\n    def test_sleep(self): time.sleep(10)\n");
    await assert.rejects(testProject([sleeping, '--timeout', '1']), (error) => {
        assert.equal(failedCheck(error, 'project_test_timeout').status, 'timed_out');
        return true;
    });
    const noisy = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def test_noise(self): print('x' * 100000, flush=True)\n");
    await assert.rejects(testProject([noisy, '--max-output-bytes', '4096']), (error) => {
        assert.equal(failedCheck(error, 'project_test_output_limit').status, 'output_limit');
        return true;
    });
});
test('Python sequential execution refuses more than the 10000-test result bound', async (t) => {
    const root = await fixture(t, `import unittest
class Application(unittest.TestCase):
    def test_pass(self): pass
def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Application('test_pass') for _ in range(10001))
`);
    await assert.rejects(testProject([root]), (error) => {
        const check = failedCheck(error);
        assert.equal(check.execution.exit_code, 2);
        assert.equal(check.report, undefined);
        return true;
    });
});
test('explicit Python test names select actual tests rather than silently validating a build', async (t) => {
    const root = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def test_one(self): pass\n    def test_two(self): pass\n", {
        args: ['test_application.Application.test_two'],
    });
    const result = await testProject([root]);
    assert.equal(result.tests_executed, 1);
    assert.match(result.checks[0].report.tests[0].name, /test_two/);
});
test('Python unittest name filtering and failfast flags reach the actual runner', async (t) => {
    const source = "import unittest\nclass Application(unittest.TestCase):\n    def test_a_fail(self): self.fail('expected fixture')\n    def test_b_pass(self): pass\n";
    const filtered = await fixture(t, source, { args: ['discover', '-s', '.', '-k', 'b_pass'] });
    const selected = await testProject([filtered]);
    assert.equal(selected.tests_executed, 1);
    assert.match(selected.checks[0].report.tests[0].name, /test_b_pass/);
    const failfast = await fixture(t, source, { args: ['discover', '-s', '.', '-f'] });
    await assert.rejects(testProject([failfast]), (error) => {
        assert.deepEqual(failedCheck(error).report.counts, { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 });
        return true;
    });
});
test('Python cancellation cannot turn an interrupted test into a passing report', async (t) => {
    const interrupted = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def test_cancel(self): raise KeyboardInterrupt()\n");
    await assert.rejects(testProject([interrupted]), (error) => {
        const check = failedCheck(error);
        assert.equal(check.execution.exit_code, 130);
        assert.equal(check.report, undefined);
        return true;
    });
    const root = await fixture(t, "import unittest,time\nclass Application(unittest.TestCase):\n    def test_sleep(self): time.sleep(10)\n");
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
test('Python failures in teardown override success and repeated reports retain test identities', async (t) => {
    const broken = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def tearDown(self): raise RuntimeError('fixture teardown')\n    def test_pass(self): pass\n");
    await assert.rejects(testProject([broken]), (error) => {
        assert.deepEqual(failedCheck(error).report.counts, { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 });
        return true;
    });
    const root = await fixture(t, "import unittest\nclass Application(unittest.TestCase):\n    def test_pass(self): pass\n");
    const first = await testProject([root]);
    const second = await testProject([root]);
    assert.deepEqual(first.test_counts, second.test_counts);
    assert.deepEqual(first.checks[0].report.tests.map(row => [row.id, row.name, row.status]), second.checks[0].report.tests.map(row => [row.id, row.name, row.status]));
});
//# sourceMappingURL=local-test-python-runner.test.js.map