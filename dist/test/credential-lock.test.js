import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { credentialLockPath, withCredentialLock } from '../credential-lock.js';
import { CliError } from '../errors.js';
const profileName = () => `test-${randomUUID().slice(0, 20)}`;
test('same-process calls serialize, release after failure, and isolate profiles', async () => {
    const profile = profileName();
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => withCredentialLock(profile, async () => {
        peak = Math.max(peak, ++active);
        await delay(30);
        active--;
    })));
    assert.equal(peak, 1);
    await assert.rejects(withCredentialLock(profile, async () => { throw new Error('synthetic'); }), /synthetic/);
    await withCredentialLock(profile, async () => {
        await withCredentialLock(profileName(), async () => undefined);
    });
    await assert.rejects(readFile(credentialLockPath(profile)), { code: 'ENOENT' });
});
test('an occupied lock times out without stealing it or touching credentials', async () => {
    const profile = profileName(), path = credentialLockPath(profile);
    await mkdir(dirname(path), { recursive: true });
    const evidence = '{"pid":99999999,"started_at":"2000-01-01T00:00:00Z"}\n';
    await writeFile(path, evidence, { flag: 'wx', mode: 0o600 });
    try {
        let called = false;
        await assert.rejects(withCredentialLock(profile, async () => { called = true; }, 75), (error) => error instanceof CliError && error.code === 'credential_busy');
        assert.equal(called, false);
        assert.equal(await readFile(path, 'utf8'), evidence);
    }
    finally {
        await rm(path);
    }
});
test('separate CLI processes rotate each saved credential once, including across config homes', { skip: process.platform !== 'linux' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-refresh-process-'));
    const profile = profileName(), credential = join(root, 'synthetic-credential');
    const secret = (n) => `bhr_${String(n).padStart(48, '0')}`;
    let current = secret(0), rotations = 0, replays = 0, active = 0, peak = 0;
    let responseStatus = 200, invalid = false;
    let deleted = false;
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req)
            body += chunk;
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/cli/v2/device/start/') {
            res.end(JSON.stringify({ device_code: 'synthetic-device', user_code: 'ABCD-EFGH',
                verification_uri_complete: 'https://app.blinkhost.me/cli/authorize?code=ABCD-EFGH', expires_in: 600, interval: 1 }));
            return;
        }
        if (req.url === '/api/cli/v2/device/poll/') {
            current = secret(99);
            res.end(JSON.stringify({ access_token: 'synthetic-login-access', refresh_token: current }));
            return;
        }
        if (req.url === '/api/cli/v2/capabilities/') {
            assert.equal(req.headers.authorization, 'Bearer synthetic-login-access');
            res.end(JSON.stringify({ actor: { id: 7, username: 'synthetic' }, features: {} }));
            return;
        }
        if (req.url === '/api/cli/v2/sessions/current/' && req.method === 'DELETE') {
            await delay(150);
            deleted = true;
            res.end('{}');
            return;
        }
        if (req.url !== '/api/cli/v2/token/refresh/') {
            res.writeHead(404).end();
            return;
        }
        active++;
        peak = Math.max(peak, active);
        await delay(75);
        const token = JSON.parse(body).refresh_token;
        res.setHeader('content-type', 'application/json');
        if (responseStatus !== 200)
            res.writeHead(responseStatus).end('{"error":"synthetic"}');
        else if (invalid)
            res.end('{"access_token":"synthetic","refresh_token":null}');
        else if (token !== current) {
            replays++;
            res.writeHead(401).end('{"error":"invalid_grant"}');
        }
        else {
            current = secret(++rotations);
            res.end(JSON.stringify({ access_token: 'synthetic-access', refresh_token: current }));
        }
        active--;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const api = new URL('../api.js', import.meta.url).href;
    await writeFile(credential, current, { mode: 0o600 });
    // Test double only: production continues using the operating-system keyring.
    await writeFile(join(root, 'secret-tool'), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = process.env.SYNTHETIC_CREDENTIAL_PATH;
const action = process.argv[2];
if (action === 'lookup') { try { process.stdout.write(fs.readFileSync(path)); } catch { process.exitCode = 1; } }
else if (action === 'store') { let body = ''; process.stdin.on('data', x => body += x); process.stdin.on('end', () => fs.writeFileSync(path, body)); }
else if (action === 'clear') { fs.rmSync(path, { force: true }); }
else if (action === 'search') { process.exitCode = process.argv[3] === '--help' || fs.existsSync(path) ? 0 : 1; }
else process.exitCode = 3;
`, { mode: 0o700 });
    const configs = [join(root, 'config-a'), join(root, 'config-b')];
    for (const config of configs) {
        await mkdir(config);
        await writeFile(join(config, 'config.json'), JSON.stringify({ activeProfile: profile, profiles: { [profile]: { apiOrigin } } }));
    }
    async function child(index = 0, action = 'create') {
        const env = { ...process.env, PATH: root, BLINKHOST_CONFIG_HOME: configs[index % 2], SYNTHETIC_CREDENTIAL_PATH: credential };
        for (const key of ['BLINKHOST_ACCESS_TOKEN', 'BLINKHOST_REFRESH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'BLINKHOST_PROFILE'])
            delete env[key];
        const invocation = action === 'login'
            ? `await (await import(${JSON.stringify(new URL('../auth.js', import.meta.url).href)})).login({profile:${JSON.stringify(profile)},openBrowser:false})`
            : `await ApiClient.${action}(${JSON.stringify(profile)})`;
        const source = `import {ApiClient} from ${JSON.stringify(api)}; try { ${invocation}; process.stdout.write('ok'); } catch(e) { process.stdout.write(e.code || 'unknown'); process.exitCode=1; }`;
        const p = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        p.stdout.on('data', x => output += x);
        p.stderr.on('data', x => output += x);
        const [code] = await once(p, 'close');
        return { code, output };
    }
    try {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(i)));
        assert.deepEqual(results, Array.from({ length: 6 }, () => ({ code: 0, output: 'ok' })));
        assert.equal(rotations, 6);
        assert.equal(replays, 0);
        assert.equal(peak, 1);
        assert.equal(await readFile(credential, 'utf8'), current);
        for (const status of [429, 503]) {
            responseStatus = status;
            assert.deepEqual(await child(), { code: 1, output: 'session_refresh_failed' });
            assert.equal(await readFile(credential, 'utf8'), current);
        }
        responseStatus = 200;
        invalid = true;
        assert.deepEqual(await child(), { code: 1, output: 'authorization_response_invalid' });
        assert.equal(await readFile(credential, 'utf8'), current);
        invalid = false;
        responseStatus = 401;
        assert.deepEqual(await child(), { code: 1, output: 'session_expired' });
        await assert.rejects(readFile(credential), { code: 'ENOENT' });
        await assert.rejects(readFile(credentialLockPath(profile)), { code: 'ENOENT' });
        responseStatus = 200;
        assert.deepEqual(await child(0, 'login'), { code: 0, output: 'ok' });
        assert.equal(rotations, 6, 'login must use its issued access token without another rotation');
        assert.equal(await readFile(credential, 'utf8'), current);
        const config = JSON.parse(await readFile(join(configs[0], 'config.json'), 'utf8'));
        assert.deepEqual(config.profiles[profile], { apiOrigin, userId: 7, username: 'synthetic' });
        const loggingOut = child(0, 'logout');
        for (let tries = 0; tries < 100; tries++) {
            try {
                await readFile(credentialLockPath(profile));
                break;
            }
            catch {
                await delay(10);
            }
        }
        const concurrentRead = child(1);
        assert.deepEqual(await loggingOut, { code: 0, output: 'ok' });
        assert.deepEqual(await concurrentRead, { code: 1, output: 'not_authenticated' });
        assert.equal(deleted, true);
        await assert.rejects(readFile(credential), { code: 'ENOENT' });
    }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=credential-lock.test.js.map