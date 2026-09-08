import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { login } from '../auth.js';
import { credentialStoreStatus } from '../credentials.js';
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
//# sourceMappingURL=auth.test.js.map