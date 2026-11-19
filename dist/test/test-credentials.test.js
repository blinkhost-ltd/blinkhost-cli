import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../api.js';
import { CliError } from '../errors.js';
import { rawApi } from '../remote.js';
import { readTestCredentialInput, runTestCredentials } from '../test-credentials.js';
const project = '11111111-1111-4111-8111-111111111111';
const moduleId = '22222222-2222-4222-8222-222222222222';
const fixtureId = '33333333-3333-4333-8333-333333333333';
const revision = '44444444-4444-4444-8444-444444444444';
const nextRevision = '55555555-5555-4555-8555-555555555555';
const selection = { schema: 'blinkhost.customer-test-credential-selection/v1', project_id: project,
    environment_id: 17, module_id: moduleId, module_binding: { schema: 'blinkhost.release-test-module-binding/v1',
        module: 'checkout', artifact_sha256: 'a'.repeat(64), runtime_policy_sha256: 'b'.repeat(64) },
    credentials: [{ name: 'PAYMENT_KEY', scope: 'preview', version: 1, fixture_id: fixtureId, fixture_revision: revision }] };
const listArgs = ['list', '--project', project, '--environment', '17', '--module', moduleId];
const path = `/api/source-control/test-credential-fixtures/${project}/17/${moduleId}/`;
const input = (value) => Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
const value = () => randomBytes(48).toString('base64') + '\nλ\n';
const body = (privateValue = value()) => ({ selection: structuredClone(selection), values: { PAYMENT_KEY: privateValue }, replaces: null });
const record = (id) => ({ id, fixture_id: fixtureId, revision, name: 'PAYMENT_KEY', scope: 'preview', version: 1,
    module_name: 'checkout', created_at: '2026-11-05T12:00:00.123456Z', revoked_at: null });
function api(t, respond) {
    t.mock.method(ApiClient, 'create', async () => ApiClient.fromAccessToken('test', { apiOrigin: 'https://fixture-api.invalid' }, 'local-test-token'));
    return t.mock.method(globalThis, 'fetch', async (url, init) => respond(new URL(url), init));
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const unconfirmed = (error) => error instanceof CliError && error.code === 'test_credentials_unconfirmed';
const invalid = (error) => error instanceof CliError && error.code === 'test_credentials_invalid';
test('fixture create preserves exact stdin bytes and emits only matching references', async (t) => {
    const privateValue = value();
    const raw = JSON.stringify(body(privateValue), null, 2);
    const fetch = api(t, (url, init) => {
        assert.equal(url.pathname, path);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer local-test-token');
        assert.ok(init.body === raw, 'Request must preserve the supplied JSON and private value');
        return json({ credentials: selection.credentials }, 201);
    });
    const result = await runTestCredentials(['create', '--stdin'], undefined, input(raw));
    assert.deepEqual(result, { credentials: selection.credentials });
    assert.ok(!JSON.stringify(result).includes(privateValue), 'Private value in command result');
    assert.equal(fetch.mock.callCount(), 1);
});
test('rotation accepts reordered metadata keys and binds exact previous references', async (t) => {
    const newer = structuredClone(selection);
    newer.credentials[0].fixture_revision = nextRevision;
    const previous = { ...selection, module_binding: { runtime_policy_sha256: selection.module_binding.runtime_policy_sha256,
            artifact_sha256: selection.module_binding.artifact_sha256, module: 'checkout', schema: selection.module_binding.schema } };
    const fetch = api(t, (_url, init) => {
        const sent = JSON.parse(String(init.body));
        assert.deepEqual(sent.replaces, previous);
        return json({ credentials: newer.credentials }, 201);
    });
    await runTestCredentials(['rotate', '--stdin'], undefined, input({ selection: newer, values: { PAYMENT_KEY: value() }, replaces: previous }));
    assert.equal(fetch.mock.callCount(), 1);
    for (const changed of [{ ...newer, environment_id: 18 }, { ...newer, credentials: selection.credentials }]) {
        await assert.rejects(runTestCredentials(['rotate', '--stdin'], undefined, input({ selection: changed, values: { PAYMENT_KEY: value() }, replaces: previous })), invalid);
    }
    assert.equal(fetch.mock.callCount(), 1);
});
test('exact-reference revocation is explicit and sends no values', async (t) => {
    const fetch = api(t, (url, init) => {
        assert.equal(url.pathname, path);
        assert.equal(init.method, 'DELETE');
        assert.deepEqual(JSON.parse(String(init.body)), { selection });
        return new Response(null, { status: 204 });
    });
    assert.deepEqual(await runTestCredentials(['revoke', '--stdin'], undefined, input({ selection })), { revoked: true });
    assert.equal(fetch.mock.callCount(), 1);
    await assert.rejects(runTestCredentials(['revoke', '--stdin'], undefined, input(body())), invalid);
    assert.equal(fetch.mock.callCount(), 1);
});
test('list follows one bounded metadata page and exact opaque cursor at a time', async (t) => {
    const records = Array.from({ length: 100 }, (_, i) => record(`60000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`));
    const cursor = records[99].id;
    const fetch = api(t, (url, init) => {
        assert.equal(url.pathname, path);
        assert.equal(init.method, 'GET');
        assert.equal(init.body, undefined);
        return url.search ? json({ fixtures: [], next_after: null }) : json({ fixtures: records, next_after: cursor });
    });
    assert.deepEqual(await runTestCredentials(listArgs), { fixtures: records, next_after: cursor });
    assert.equal(fetch.mock.callCount(), 1, 'Do not fetch arbitrary history automatically');
    assert.deepEqual(await runTestCredentials([...listArgs, '--after', cursor]), { fixtures: [], next_after: null });
    const requested = fetch.mock.calls[1].arguments[0];
    assert.equal(new URL(requested instanceof Request ? requested.url : requested).searchParams.get('after'), cursor);
});
test('private stdin rejects invalid UTF-8, oversize input, early close and timeout', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(65537, 32)]) {
        await assert.rejects(readTestCredentialInput(Readable.from([bytes])), CliError);
    }
    const closing = new PassThrough();
    const closed = readTestCredentialInput(closing);
    closing.destroy();
    await assert.rejects(closed, e => e instanceof CliError && e.code === 'test_credentials_input_failed');
    const waiting = new PassThrough();
    await assert.rejects(readTestCredentialInput(waiting, 20), e => e instanceof CliError && e.code === 'test_credentials_input_timeout');
    assert.equal(waiting.destroyed, true);
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    await assert.rejects(readTestCredentialInput(tty), e => e instanceof CliError && e.code === 'test_credentials_stdin_required');
    tty.destroy();
});
test('malformed or ambiguous private documents never authenticate or send a request', async (t) => {
    const authenticated = t.mock.method(ApiClient, 'create', async () => { throw new Error('Unexpected authentication'); });
    const valid = JSON.stringify(body());
    const samples = ['', '{}', 'null', '---\nvalues: secret', '[', '['.repeat(30), '\ufeff' + valid,
        valid.replace('"values":', '"values":{},"values":'),
        valid.replace('"version":1', '"version":1,"versio\\u006e":1'),
        { ...body(), selection: { ...selection, environment_id: Number.MAX_SAFE_INTEGER + 1 } },
        { ...body(), selection: { ...selection, project_id: project + '?redirect=1' } },
        { ...body(), values: { PAYMENT_KEY: 'x'.repeat(16385) } },
        { ...body(), values: { PAYMENT_KEY: 'λ'.repeat(8193) } },
        { ...body(), values: { PAYMENT_KEY: '\ud800' } }, { ...body(), values: { PAYMENT_KEY: '\0' } },
        { ...body(), values: { PAYMENT_KEY: 17 } }, { ...body(), values: { UNSELECTED: value() } },
        { ...body(), extra: true }, { ...body(), replaces: selection }];
    for (const sample of samples)
        await assert.rejects(runTestCredentials(['create', '--stdin'], undefined, input(sample)), invalid);
    assert.equal(authenticated.mock.callCount(), 0);
});
test('arguments cannot contain values, duplicate scope options or unsafe path identities', async (t) => {
    const authenticated = t.mock.method(ApiClient, 'create', async () => { throw new Error('Unexpected authentication'); });
    const privateValue = value();
    for (const args of [[], ['create'], ['create', '--stdin', privateValue], ['create', '--value', privateValue],
        ['list', '--project', project, '--environment', '17', '--module', moduleId, '--project', project],
        [...listArgs, '--after', 'invalid'], [...listArgs, '--value', privateValue],
        ['list', '--project', project, '--environment', '17.0', '--module', moduleId]]) {
        await assert.rejects(runTestCredentials(args, undefined, input(body())), error => invalid(error)
            && !JSON.stringify(error).includes(privateValue) && !error.message.includes(privateValue));
    }
    assert.equal(authenticated.mock.callCount(), 0);
});
test('HTTP and transport failures suppress reflected values and do not retry writes', async (t) => {
    const privateValue = value();
    let status = 403;
    const fetch = api(t, () => json({ detail: privateValue }, status));
    for (status of [401, 403, 404, 409, 429, 500, 503]) {
        await assert.rejects(runTestCredentials(['create', '--stdin'], undefined, input(body(privateValue))), error => unconfirmed(error)
            && !JSON.stringify(error).includes(privateValue) && !error.message.includes(privateValue));
    }
    assert.equal(fetch.mock.callCount(), 7);
    fetch.mock.mockImplementation(async () => { throw new Error(privateValue); });
    await assert.rejects(runTestCredentials(['create', '--stdin'], undefined, input(body(privateValue))), unconfirmed);
    assert.equal(fetch.mock.callCount(), 8);
});
test('unexpected response fields, mismatched references and excessive bodies never reach output', async (t) => {
    const privateValue = value();
    let response;
    api(t, () => json(response));
    for (response of [{ credentials: selection.credentials, values: { PAYMENT_KEY: privateValue } },
        { credentials: [{ ...selection.credentials[0], fixture_revision: nextRevision }] },
        { credentials: [], detail: privateValue }, { detail: privateValue.repeat(1100) }]) {
        await assert.rejects(runTestCredentials(['create', '--stdin'], undefined, input(body(privateValue))), unconfirmed);
    }
    for (response of [{ fixtures: [{ ...record(revision), sealed_value: privateValue }], next_after: null },
        { fixtures: [record(revision), record(revision)], next_after: null },
        { fixtures: [], next_after: revision }, { fixtures: Array.from({ length: 101 }, () => record(revision)), next_after: null },
        { fixtures: [{ ...record(revision), module_name: privateValue }], next_after: null }]) {
        await assert.rejects(runTestCredentials(listArgs), unconfirmed);
    }
});
test('raw API refuses fixture writes before authentication', async (t) => {
    const authenticated = t.mock.method(ApiClient, 'create', async () => { throw new Error('Unexpected authentication'); });
    for (const method of ['POST', 'DELETE'])
        await assert.rejects(rawApi([method, path]), error => error instanceof CliError && error.code === 'unsafe_secret_command');
    assert.equal(authenticated.mock.callCount(), 0);
});
test('actual CLI help and invalid-input JSON expose no private arguments', async () => {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const exec = promisify(execFile);
    const help = await exec(process.execPath, [cli, 'test-credentials', '--help', '--json', '--non-interactive']);
    assert.match(help.stdout, /test-credentials/);
    const privateValue = value();
    try {
        await exec(process.execPath, [cli, 'test-credentials', 'create', '--value', privateValue, '--json', '--non-interactive']);
        assert.fail('Invalid arguments must fail');
    }
    catch (error) {
        const result = error;
        assert.equal(result.code, 3);
        assert.ok(!result.stdout.includes(privateValue) && !result.stderr.includes(privateValue), 'Private argument in terminal output');
        assert.match(result.stdout + result.stderr, /test_credentials_invalid/);
    }
});
//# sourceMappingURL=test-credentials.test.js.map