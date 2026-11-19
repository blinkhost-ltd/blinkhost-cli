import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CliError, EXIT } from '../errors.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { runDev } from '../workflows.js';
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-local-dev-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = createScaffold({ name: 'local-dev', framework: 'html', packageManager: 'npm', modules: [] });
    await writeScaffoldAtomically(join(root, 'app'), app.files, app.manifest);
    return join(root, 'app');
}
const code = (expected, exitCode) => (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, expected);
    assert.equal(error.exitCode, exitCode);
    return true;
};
for (const options of [['--local-config', 'config.json'], ['--state-dir', 'state']]) {
    test(`dev rejects incomplete local stack option ${options[0]} before touching state`, async (t) => {
        const root = await fixture(t);
        await assert.rejects(runDev([root, ...options], true), code('local_stack_options_required', EXIT.usage));
        await assert.rejects(access(join(root, 'state')));
    });
}
for (const option of ['--host', '--port']) {
    test(`dev rejects ${option} with local stack without spawning`, async (t) => {
        const root = await fixture(t);
        await assert.rejects(runDev([root, '--local-config', 'config.json', '--state-dir', 'state', option,
            option === '--port' ? '3000' : '0.0.0.0'], true), code('local_stack_listen_options', EXIT.usage));
        await assert.rejects(access(join(root, 'state')));
    });
}
test('dev rejects missing values, unknown options and extra roots before local stack startup', async (t) => {
    const root = await fixture(t);
    await assert.rejects(runDev([root, '--local-config'], true), code('missing_option_value', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'config.json', '--state-dir', 'state', '--reset'], true), code('unexpected_argument', EXIT.usage));
    await assert.rejects(runDev([root, root, '--local-config', 'config.json', '--state-dir', 'state'], true), code('unexpected_argument', EXIT.usage));
    await assert.rejects(access(join(root, 'state')));
});
test('dev validates the application manifest before opening local stack configuration', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'blinkhost.yaml'), 'invalid: [');
    await assert.rejects(runDev([root, '--local-config', 'missing.json', '--state-dir', 'state'], true), error => error instanceof CliError && ['project_invalid', 'manifest_invalid'].includes(error.code));
    await assert.rejects(access(join(root, 'state')));
});
test('dev local configuration resolves relative to the project and screens parser details', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'config.json'), 'invalid-secret-parser-input');
    await assert.rejects(runDev(['--local-config', 'config.json', '--state-dir', 'state', root], true), error => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'invalid_local_stack_json');
        assert.doesNotMatch(error.message + error.details.join(' '), /secret-parser-input/);
        return true;
    });
    await assert.rejects(access(join(root, 'state')));
});
test('static dev without explicit local stack retains its ordinary unsupported-process result', async (t) => {
    const root = await fixture(t);
    await assert.rejects(runDev([root], true), code('dev_command_unavailable', EXIT.validation));
});
test('artifact watching requires the explicit local stack and rejects repeated flags', async (t) => {
    const root = await fixture(t);
    await assert.rejects(runDev([root, '--watch-artifact'], true), code('local_stack_watch_options_required', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'missing.json', '--state-dir', 'state', '--watch-artifact', '--watch-artifact'], true), code('unexpected_argument', EXIT.usage));
    await assert.rejects(access(join(root, 'state')));
});
test('source compilation requires the explicit local stack and cannot silently combine watchers', async (t) => {
    const root = await fixture(t);
    await assert.rejects(runDev([root, '--local-build-config', 'build.json'], true), code('local_source_build_options_required', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'stack.json', '--state-dir', 'state', '--local-build-config'], true), code('missing_option_value', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'stack.json', '--state-dir', 'state', '--local-build-config', 'build.json', '--watch-artifact'], true), code('local_source_build_watch_conflict', EXIT.usage));
    await assert.rejects(access(join(root, 'state')));
});
test('source watching requires explicit compilation and rejects duplicate flags before startup', async (t) => {
    const root = await fixture(t);
    await assert.rejects(runDev([root, '--watch-source'], true), code('local_source_watch_options_required', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'stack.json', '--state-dir', 'state', '--watch-source'], true), code('local_source_watch_options_required', EXIT.usage));
    await assert.rejects(runDev([root, '--local-config', 'stack.json', '--state-dir', 'state', '--local-build-config', 'build.json', '--watch-source', '--watch-source'], true), code('unexpected_argument', EXIT.usage));
    await assert.rejects(access(join(root, 'state')));
});
test('packaged local stack and its dependency graph match their canonical shared sources', async () => {
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    for (const filename of ['local-development/local-stack.mjs', 'local-development/frontend-proxy.mjs', 'local-development/provider-fixtures.mjs',
        'local-development/native-database.mjs',
        'local-development/provider-grants.mjs', 'local-development/artifact-watch.mjs',
        'local-development/blinkhost.local.example.json', 'local-development/README.md', 'local-development/hello.rs', 'javascript-runtime/resource-profiles.js', 'javascript-runtime/resource-limits.js',
        'local-development/provider-fixtures.example.json', 'local-development/test-provider-example.mjs']) {
        const canonical = await readFile(resolve(process.cwd(), 'local-tools', filename));
        assert.equal(sha(await readFile(join(process.cwd(), 'dist', filename))), sha(canonical), filename);
    }
});
//# sourceMappingURL=local-dev.test.js.map