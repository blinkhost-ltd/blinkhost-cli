import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CliError, EXIT } from '../errors.js';
import { LOCAL_TEST_CONFIG, discoverLocalProjects } from '../local-test-config.js';
import { LocalTestChecksFailure, LocalTestCommandFailure } from '../local-test-command.js';
import { writeScaffoldAtomically } from '../project.js';
import { createScaffold } from '../templates.js';
import { supportedNodeVersion } from '../version.js';
import { localProjectCheckMessage, testProject } from '../workflows.js';
async function fixture(t) {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-config-checks-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'project');
    const scaffold = createScaffold({ name: 'checks', framework: 'html', packageManager: 'npm', modules: [
            { name: 'api', language: 'rust' }, { name: 'worker', language: 'python' },
        ] });
    await writeScaffoldAtomically(root, scaffold.files, scaffold.manifest);
    return root;
}
function check(id, code = 'process.exit(0)', target = 'project') {
    return { id, command: process.execPath, args: ['-e', code], target, kind: 'test' };
}
async function configure(root, checks) {
    await writeFile(join(root, LOCAL_TEST_CONFIG), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks }));
}
test('explicit commands run in declared module roots and retain honest native/WASM evidence', async (t) => {
    const root = await fixture(t);
    await configure(root, [
        { ...check('unit', "require('node:fs').writeFileSync('unit-ran','yes')", 'module:api'), profile: 'native' },
        { ...check('integration', "require('node:fs').writeFileSync('integration-ran','yes')", 'module:worker'), kind: 'integration', profile: 'wasm' },
    ]);
    const result = await testProject([root]);
    assert.equal(result.status, 'checks_succeeded');
    assert.equal(result.configuration, 'explicit');
    assert.equal(result.tests_executed, null);
    assert.deepEqual(result.coverage, { native: 'not_collected', wasm: 'not_collected' });
    assert.ok(result.backend_modules.every(row => row.status === 'test_command_succeeded'));
    assert.deepEqual(result.checks.map(row => [row.id, row.profile, row.status]), [['unit', 'native', 'succeeded'], ['integration', 'wasm', 'succeeded']]);
    assert.equal(await readFile(join(root, '_server_islands/api/unit-ran'), 'utf8'), 'yes');
    assert.equal(await readFile(join(root, '_server_islands/worker/integration-ran'), 'utf8'), 'yes');
    assert.doesNotMatch(localProjectCheckMessage(result), /were not tested/);
});
test('module builds do not count as tests, including repeated builds', async (t) => {
    const root = await fixture(t);
    await configure(root, [{ ...check('one', undefined, 'module:api'), kind: 'build' },
        { ...check('two', undefined, 'module:api'), kind: 'build' }]);
    const result = await testProject([root]);
    assert.equal(result.status, 'build_only');
    assert.equal(result.tests_executed, 0);
    assert.equal(result.test_evidence, 'not_run');
    assert.equal(result.backend_modules[0].status, 'build_only');
    assert.match(localProjectCheckMessage(result), /2 backend module\(s\) were not tested/);
});
test('successful module tests retain their status when a later build also succeeds', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('unit', undefined, 'module:api'), { ...check('build', undefined, 'module:api'), kind: 'build' }]);
    assert.equal((await testProject([root])).backend_modules[0].status, 'test_command_succeeded');
});
test('literal command arguments do not invoke a shell and are not reflected into receipts', async (t) => {
    const root = await fixture(t);
    const literal = '$(touch unexpected) `touch unexpected` token=synthetic-sensitive-value';
    await configure(root, [{ ...check('literal'), args: ['-e', "require('node:fs').writeFileSync('literal.txt',process.argv[1])", literal] }]);
    const result = await testProject([root]);
    assert.equal(await readFile(join(root, 'literal.txt'), 'utf8'), literal);
    await assert.rejects(access(join(root, 'unexpected')));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-value|process\.argv/);
});
test('failed check stops the sequence and reports completed, failed and unrun modules', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('one'), check('fail', "console.log('token=synthetic-sensitive-value'); process.exit(7)", 'module:api'),
        check('pending', "require('node:fs').writeFileSync('unexpected','yes')", 'module:worker')]);
    await assert.rejects(testProject([root]), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.code, 'project_test_failed');
        const result = error.projectChecks;
        assert.deepEqual(result.checks.map(row => row.status), ['succeeded', 'failed', 'not_run']);
        assert.deepEqual(result.backend_modules.map(row => row.status), ['failed', 'not_run']);
        assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-value/);
        return true;
    });
    await assert.rejects(access(join(root, '_server_islands/worker/unexpected')));
});
test('all configuration rows validate before the first command executes', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('first', "require('node:fs').writeFileSync('unexpected','yes')"), check('bad', undefined, 'module:missing')]);
    await assert.rejects(testProject([root]), (error) => error instanceof CliError && error.code === 'invalid_local_test_config');
    await assert.rejects(access(join(root, 'unexpected')));
});
for (const [name, checks] of [
    ['empty checks', []], ['duplicate IDs', [check('same'), check('same')]],
    ['unknown field', [{ ...check('one'), shell: true }]], ['invalid kind', [{ ...check('one'), kind: 'guess' }]],
    ['invalid profile', [{ ...check('one'), profile: 'automatic' }]], ['outside cwd', [{ ...check('one'), cwd: '../outside' }]],
    ['absolute cwd', [{ ...check('one'), cwd: '/tmp' }]], ['control argument', [{ ...check('one'), args: ['secret\n'] }]],
    ['too many checks', Array.from({ length: 33 }, (_, i) => check('test' + i))],
]) {
    test(`configuration rejects ${name}`, async (t) => {
        const root = await fixture(t);
        await configure(root, [...checks]);
        await assert.rejects(testProject([root]), (error) => error instanceof CliError && error.code === 'invalid_local_test_config');
    });
}
test('symlink config and cwd are rejected, and oversized config reads stay bounded', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'settings.json'), JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks: [check('one')] }));
    await symlink('settings.json', join(root, LOCAL_TEST_CONFIG));
    await assert.rejects(testProject([root]), (error) => error instanceof CliError && error.code === 'invalid_local_test_config');
    await rm(join(root, LOCAL_TEST_CONFIG));
    await symlink('_server_islands/api', join(root, 'linked'));
    await configure(root, [{ ...check('one'), cwd: 'linked' }]);
    await assert.rejects(testProject([root]), (error) => error instanceof CliError && error.code === 'invalid_local_test_config');
    await writeFile(join(root, LOCAL_TEST_CONFIG), ' '.repeat(65_537));
    await assert.rejects(testProject([root]), (error) => error instanceof CliError && error.code === 'invalid_local_test_config');
});
test('nested project discovery lists omissions without running or following links or dependencies', async (t) => {
    const root = await fixture(t);
    for (const path of ['apps/second', 'node_modules/hidden']) {
        await mkdir(join(root, path), { recursive: true });
        await writeFile(join(root, path, 'blinkhost.yaml'), 'invalid but discoverable');
    }
    await symlink('apps/second', join(root, 'linked-project'));
    const result = await testProject([root]);
    assert.deepEqual(result.discovery.nested_projects, [{ path: 'apps/second', status: 'not_run', reason: 'run_explicitly' }]);
    assert.equal(result.discovery.complete, true);
    assert.match(localProjectCheckMessage(result), /1 nested project\(s\) were not run/);
});
test('bounded discovery reports deeper unexplored directories', async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, ...Array(10).fill('deep')), { recursive: true });
    const result = await discoverLocalProjects(root);
    assert.equal(result.complete, false);
    assert.ok(result.directories_scanned <= result.limits.directories);
    assert.ok(result.entries_scanned <= result.limits.entries);
});
test('pre-cancelled discovery never starts configured commands', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('one', "require('node:fs').writeFileSync('unexpected','yes')")]);
    const controller = new AbortController();
    controller.abort('SIGTERM');
    await assert.rejects(testProject([root], false, controller.signal), (error) => error instanceof CliError && error.exitCode === 143 && error.code === 'project_test_cancelled');
    await assert.rejects(access(join(root, 'unexpected')));
});
test('multiple commands share the output cap and retain unrun trailing checks', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('first', "process.stdout.write('x'.repeat(700))"),
        check('second', "process.stderr.write('y'.repeat(700))"), check('pending')]);
    await assert.rejects(testProject([root, '--max-output-bytes', '1024']), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.code, 'project_test_output_limit');
        const checks = error.projectChecks.checks;
        assert.deepEqual(checks.map(row => row.status), ['succeeded', 'output_limit', 'not_run']);
        // Overflowing chunks are discarded whole so truncated credentials cannot escape screening.
        assert.ok(checks.reduce((sum, row) => sum + (row.execution?.captured_output_bytes ?? 0), 0) <= 1024);
        assert.equal(checks[0]?.execution?.captured_output_bytes, 700);
        assert.ok((checks[1]?.execution?.observed_output_bytes ?? 0) > 324);
        return true;
    });
});
test('exactly exhausted output budget prevents launching the next command', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('first', "process.stdout.write('x'.repeat(1024))"), check('pending')]);
    await assert.rejects(testProject([root, '--max-output-bytes', '1024']), (error) => {
        assert.ok(error instanceof LocalTestChecksFailure);
        assert.equal(error.code, 'project_test_output_limit');
        assert.deepEqual(error.projectChecks.checks.map(row => row.status), ['succeeded', 'not_run']);
        return true;
    });
});
test('multiple commands share the timeout rather than each receiving a fresh allowance', async (t) => {
    const root = await fixture(t);
    await configure(root, [check('first', 'setTimeout(()=>{},650)'), check('second', 'setTimeout(()=>{},650)'), check('pending')]);
    await assert.rejects(testProject([root, '--timeout', '1']), (error) => {
        assert.ok(error instanceof LocalTestCommandFailure);
        assert.equal(error.code, 'project_test_timeout');
        const checks = error.projectChecks.checks;
        assert.deepEqual(checks.map(row => row.status), ['succeeded', 'timed_out', 'not_run']);
        assert.ok(checks[1].execution.limits.timeout_ms < 500);
        return true;
    });
});
test('CLI failure JSON exposes bounded aggregate check status without command arguments', { skip: !supportedNodeVersion() }, async (t) => {
    const root = await fixture(t);
    await configure(root, [check('fail', 'process.exit(7)'), check('pending')]);
    const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'test', root, '--json'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, EXIT.validation);
    const response = JSON.parse(result.stdout);
    assert.equal(response.error.code, 'project_test_failed');
    assert.deepEqual(response.error.project_checks.checks.map((row) => row.status), ['failed', 'not_run']);
    assert.doesNotMatch(result.stdout, /process\.exit/);
    assert.equal(result.stderr, '');
});
//# sourceMappingURL=local-test-config.test.js.map