import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, publicRequest } from '../api.js';
const origin = 'https://api.blinkhost.me';
test('API defaults remain JSON and explicit headers replace them case-insensitively', async () => {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json({ ok: true });
    };
    try {
        await publicRequest(origin, '/test/', { method: 'POST', body: JSON.stringify({ example: true }) });
        assert.ok(requests[0]);
        assert.equal(requests[0].headers.get('content-type'), 'application/json');
        assert.equal(requests[0].headers.get('accept'), 'application/json');
        assert.match(requests[0].headers.get('user-agent'), /^BlinkHost-CLI\//);
        const variants = [
            { 'Content-Type': 'application/octet-stream', Accept: 'application/zip' },
            { 'cOnTeNt-TyPe': 'application/octet-stream', aCcEpT: 'application/zip' },
            new Headers({ 'content-type': 'application/octet-stream', accept: 'application/zip' }),
            [['CONTENT-TYPE', 'application/octet-stream'], ['ACCEPT', 'application/zip']],
        ];
        for (const headers of variants) {
            await publicRequest(origin, '/test/', { method: 'POST', body: 'synthetic', headers });
            const request = requests.at(-1);
            assert.equal(request.headers.get('content-type'), 'application/octet-stream');
            assert.equal(request.headers.get('accept'), 'application/zip');
            assert.equal(await request.text(), 'synthetic');
            assert.equal(request.redirect, 'error');
        }
        assert.equal(requests.length, variants.length + 1);
    }
    finally {
        globalThis.fetch = original;
    }
});
test('authenticated serialized multipart retains its exact boundary and request identity', async () => {
    const original = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
        captured = new Request(url, init);
        return Response.json({ status: 'queued' }, { status: 202 });
    };
    try {
        const form = new FormData();
        form.set('environment_name', 'preview');
        form.set('file', new Blob(['synthetic archive'], { type: 'application/zip' }), 'frontend.zip');
        const source = new Request(`${origin}/test/`, { method: 'POST', body: form });
        const body = await source.arrayBuffer();
        const contentType = source.headers.get('content-type');
        const client = ApiClient.fromAccessToken('test', { apiOrigin: origin }, 'synthetic-test-token');
        assert.deepEqual(await client.request('/test/', { method: 'POST', body,
            headers: { 'Content-Type': contentType, Authorization: 'must-be-replaced',
                'X-Request-ID': 'synthetic-request', 'Idempotency-Key': 'synthetic-intent' } }), { status: 'queued' });
        assert.ok(captured);
        assert.equal(captured.headers.get('content-type'), contentType);
        assert.equal(captured.headers.get('authorization'), 'Bearer synthetic-test-token');
        assert.equal(captured.headers.get('x-request-id'), 'synthetic-request');
        assert.equal(captured.headers.get('idempotency-key'), 'synthetic-intent');
        assert.deepEqual(await captured.clone().arrayBuffer(), body);
        const parsed = await captured.formData();
        assert.equal(parsed.get('environment_name'), 'preview');
        const file = parsed.get('file');
        assert.equal(file.name, 'frontend.zip');
        assert.equal(await file.text(), 'synthetic archive');
    }
    finally {
        globalThis.fetch = original;
    }
});
test('upload rejection and uncertain network failure are single attempts, never automatic retries', async () => {
    const original = globalThis.fetch;
    const client = ApiClient.fromAccessToken('test', { apiOrigin: origin }, 'synthetic-test-token');
    let calls = 0;
    try {
        globalThis.fetch = async (url, init) => {
            calls++;
            const request = new Request(url, init);
            assert.equal(request.redirect, 'error');
            assert.ok(request.headers.get('x-request-id'));
            assert.ok(request.headers.get('idempotency-key'));
            return Response.json({ detail: 'Unsupported media type.' }, { status: 415 });
        };
        await assert.rejects(client.request('/test/', { method: 'POST', body: 'synthetic' }), { code: 'api_415' });
        assert.equal(calls, 1);
        globalThis.fetch = async () => { calls++; throw new TypeError('synthetic lost response'); };
        await assert.rejects(client.request('/test/', { method: 'POST', body: 'synthetic' }), { code: 'network_error' });
        assert.equal(calls, 2);
    }
    finally {
        globalThis.fetch = original;
    }
});
//# sourceMappingURL=api.test.js.map