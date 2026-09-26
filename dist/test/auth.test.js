import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { login } from '../auth.js';
import { credentialStoreStatus, deleteRefreshCredential, getRefreshCredential } from '../credentials.js';
import { CliError } from '../errors.js';
test('missing credential tooling stops login before device authorization or browser progress', async () => {
    const previousPath = process.env.PATH;
    const previousFetch = globalThis.fetch;
    const empty = await mkdtemp(join(tmpdir(), 'blinkhost-missing-credential-tool-'));
    let calls = 0;
    const progress = [];
    process.env.PATH = empty;
    globalThis.fetch = async () => { calls += 1; throw new Error('Unexpected network request'); };
    try {
        await assert.rejects(login({ openBrowser: false, scopes: ['ai:read'], progress: line => progress.push(line) }), (error) => error instanceof CliError && error.code === 'credential_store_unavailable');
        assert.equal(calls, 0);
        assert.deepEqual(progress, []);
    }
    finally {
        globalThis.fetch = previousFetch;
        if (previousPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = previousPath;
    }
});
test('Linux credential diagnostic uses supported help without reading a keyring', { skip: process.platform !== 'linux' }, async () => {
    const previousPath = process.env.PATH;
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-credential-tool-'));
    // Match libsecret: global --version fails; subcommand help succeeds without D-Bus.
    await writeFile(join(root, 'secret-tool'), '#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = search ] && [ "$2" = --help ]\n', { mode: 0o700 });
    process.env.PATH = root;
    try {
        assert.deepEqual(await credentialStoreStatus(), { available: true, provider: 'linux-secret-service', remediation: null });
    }
    finally {
        if (previousPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = previousPath;
    }
});
test('Linux credential lookup distinguishes an unavailable keyring from a missing item', { skip: process.platform !== 'linux' }, async () => {
    const previousPath = process.env.PATH;
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-credential-failure-'));
    await writeFile(join(root, 'secret-tool'), '#!/bin/sh\nprintf "synthetic-private-value: session unavailable" >&2\nexit 1\n', { mode: 0o700 });
    process.env.PATH = root;
    try {
        await assert.rejects(getRefreshCredential('synthetic-profile'), (error) => {
            assert.ok(error instanceof CliError);
            assert.equal(error.code, 'credential_store_failed');
            assert.ok(!error.message.includes('synthetic-private-value'));
            return true;
        });
        await writeFile(join(root, 'secret-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        assert.equal(await getRefreshCredential('synthetic-profile'), null);
    }
    finally {
        if (previousPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = previousPath;
    }
});
test('Linux silent locked-item reads and deletes are not mistaken for missing credentials', { skip: process.platform !== 'linux' }, async () => {
    const previousPath = process.env.PATH;
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-credential-locked-'));
    // Model libsecret's silent lookup failure after an unlock prompt is cancelled.
    // Metadata search can still find the exact item without requesting an unlock.
    await writeFile(join(root, 'secret-tool'), '#!/bin/sh\n[ "$#" = 5 ] && [ "$2" = service ] && [ "$3" = blinkhost-cli ] && [ "$4" = profile ] && [ "$5" = "synthetic-profile" ] || exit 3\nif [ "$1" = search ]; then printf "synthetic-private-value: locked item metadata"; exit 0; fi\nexit 1\n', { mode: 0o700 });
    process.env.PATH = root;
    try {
        for (const operation of [getRefreshCredential, deleteRefreshCredential]) {
            await assert.rejects(operation('synthetic-profile'), (error) => {
                assert.ok(error instanceof CliError);
                assert.equal(error.code, 'credential_store_failed');
                assert.ok(!error.message.includes('synthetic-private-value'));
                return true;
            });
        }
        await writeFile(join(root, 'secret-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        assert.equal(await getRefreshCredential('synthetic-profile'), null);
        await deleteRefreshCredential('synthetic-profile');
    }
    finally {
        if (previousPath === undefined)
            delete process.env.PATH;
        else
            process.env.PATH = previousPath;
    }
});
//# sourceMappingURL=auth.test.js.map