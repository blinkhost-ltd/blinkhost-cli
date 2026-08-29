import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_API_ORIGIN, readConfig, validateApiOrigin, writeConfig } from '../config.js';
import { CliError } from '../errors.js';
import { rawApi, readProjectLink, writeProjectLink } from '../remote.js';
import { completion, runPlugins, supportBundle } from '../workflows.js';
test('profile configuration is private and API origins reject unsafe forms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-config-'));
    const previous = process.env.BLINKHOST_CONFIG_HOME;
    process.env.BLINKHOST_CONFIG_HOME = root;
    try {
        assert.equal(validateApiOrigin(DEFAULT_API_ORIGIN), DEFAULT_API_ORIGIN);
        assert.throws(() => validateApiOrigin('http://api.example.com'), CliError);
        assert.throws(() => validateApiOrigin('https://user:secret@example.com'), CliError);
        await writeConfig({ activeProfile: 'work', profiles: { work: { apiOrigin: DEFAULT_API_ORIGIN } } });
        assert.equal((await readConfig()).activeProfile, 'work');
        assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
    }
    finally {
        if (previous === undefined)
            delete process.env.BLINKHOST_CONFIG_HOME;
        else
            process.env.BLINKHOST_CONFIG_HOME = previous;
    }
});
test('project links are explicit, local, and contain no credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-link-'));
    const written = await writeProjectLink('2a594fd8-cc93-47c1-864f-697765d5bd23', 'default', root);
    assert.deepEqual(await readProjectLink(root), written);
    const raw = await readFile(join(root, '.blinkhost', 'project.json'), 'utf8');
    assert.equal(raw.includes('token'), false);
    assert.equal(raw.includes('secret'), false);
});
test('raw API blocks staff, internal, auth, and secret-bearing mutation paths before authentication', async () => {
    for (const [method, path] of [['GET', '/api/internal/status/'], ['GET', '/api/ops/legal/'], ['POST', '/api/auth/login/'], ['POST', '/api/project-secrets/']]) {
        await assert.rejects(rawApi([method, path]), CliError);
    }
});
test('shell completion is deterministic', () => {
    assert.match(completion('bash'), /complete/);
    assert.match(completion('zsh'), /#compdef/);
    assert.match(completion('fish'), /complete -c blinkhost/);
    assert.match(completion('powershell'), /Register-ArgumentCompleter/);
    assert.throws(() => completion('nushell'), CliError);
});
test('plugins are digest pinned and stop after executable changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-plugin-'));
    const previous = process.env.BLINKHOST_CONFIG_HOME;
    process.env.BLINKHOST_CONFIG_HOME = join(root, 'config');
    const executable = join(root, 'example-plugin');
    try {
        await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        await chmod(executable, 0o700);
        await runPlugins(['add', executable, '--name', 'example']);
        const verified = await runPlugins(['verify', 'example']);
        assert.equal(verified.verified, true);
        await writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        await assert.rejects(runPlugins(['verify', 'example']), /changed after approval/);
    }
    finally {
        if (previous === undefined)
            delete process.env.BLINKHOST_CONFIG_HOME;
        else
            process.env.BLINKHOST_CONFIG_HOME = previous;
    }
});
test('support bundles exclude source paths and secret declarations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-support-'));
    const output = join(root, 'bundle.json');
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
        await supportBundle(['--output', output]);
        const raw = await readFile(output, 'utf8');
        assert.equal(raw.includes('access_token'), false);
        assert.equal(raw.includes('refresh_token'), false);
        assert.equal(raw.includes(previousCwd), false);
    }
    finally {
        process.chdir(previousCwd);
    }
});
//# sourceMappingURL=v2.test.js.map