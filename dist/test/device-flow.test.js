import assert from 'node:assert/strict';
import test from 'node:test';
import { pollDeviceAuthorization, validateDeviceAuthorization, validateDeviceTokens } from '../device-flow.js';
import { CliError } from '../errors.js';
const device = { device_code: 'synthetic-device-code', expires_in: 600, interval: 5 };
function harness(responses) {
    let time = 0;
    let calls = 0;
    const waits = [];
    return {
        waits, calls: () => calls,
        services: {
            now: () => time,
            sleep: async (milliseconds) => { waits.push(milliseconds); time += milliseconds; },
            request: async (_origin, path, init) => {
                assert.equal(path, '/api/cli/v2/device/poll/');
                assert.deepEqual(JSON.parse(String(init?.body)), { device_code: device.device_code, code_verifier: 'synthetic-verifier' });
                const next = responses[calls++];
                assert.ok(next, 'unexpected extra authorization request');
                if (next instanceof Error)
                    throw next;
                return { response: new Response(null, { status: next.status }), data: next.data };
            },
        },
    };
}
const pending = { status: 428, data: { error: 'authorization_pending' } };
const slow = { status: 429, data: { error: 'slow_down' } };
const success = { status: 200, data: { refresh_token: 'synthetic-result' } };
const isError = (code) => (error) => error instanceof CliError && error.code === code;
test('device authorization validates exact code-bound browser destination before use', () => {
    const valid = { ...device, user_code: 'ABCD-EFGH', verification_uri_complete: 'https://app.blinkhost.me/cli/authorize?code=ABCD-EFGH' };
    assert.deepEqual(validateDeviceAuthorization(valid), valid);
    for (const changed of [null, [], {}, { ...valid, expires_in: 0 }, { ...valid, user_code: 'ABCD-EFGH\n' },
        { ...valid, verification_uri_complete: 'https://example.com/cli/authorize?code=ABCD-EFGH' },
        { ...valid, verification_uri_complete: 'https://app.blinkhost.me/cli/authorize?code=ABCD-EFGH&other=1' },
        { ...valid, verification_uri_complete: 'https://app.blinkhost.me/cli/authorize?code=ABCD-EFGJ' },
        { ...valid, verification_uri_complete: 'javascript:alert(1)' }]) {
        assert.throws(() => validateDeviceAuthorization(changed), isError('authorization_response_invalid'));
    }
});
test('malformed token delivery is rejected before credential storage', () => {
    const valid = { access_token: 'synthetic-access', refresh_token: `bhr_${'a'.repeat(43)}` };
    assert.deepEqual(validateDeviceTokens(valid), valid);
    for (const changed of [null, [], {}, 'token', { ...valid, access_token: '' },
        { ...valid, refresh_token: undefined }, { ...valid, refresh_token: 'bhr_' },
        { ...valid, refresh_token: `${valid.refresh_token}\n` }, { ...valid, refresh_token: 'bhr_' + 'a'.repeat(257) }]) {
        assert.throws(() => validateDeviceTokens(changed), isError('authorization_response_invalid'));
    }
});
test('slow_down increases all subsequent polling intervals and success is not replayed', async () => {
    const h = harness([slow, pending, slow, success]);
    assert.deepEqual(await pollDeviceAuthorization('https://api.blinkhost.me', device, 'synthetic-verifier', h.services), success.data);
    assert.deepEqual(h.waits, [5000, 10000, 10000, 15000]);
    assert.equal(h.calls(), 4);
});
test('local expiry stops without a final request after the deadline', async () => {
    const h = harness([pending]);
    await assert.rejects(pollDeviceAuthorization('https://api.blinkhost.me', { ...device, expires_in: 7 }, 'synthetic-verifier', h.services), isError('authorization_expired'));
    assert.deepEqual(h.waits, [5000, 2000]);
    assert.equal(h.calls(), 1);
});
test('server expiry and denial give actionable errors without retrying', async () => {
    for (const [remote, expected] of [['expired_token', 'authorization_expired'], ['access_denied', 'access_denied']]) {
        const h = harness([{ status: 400, data: { error: remote } }]);
        await assert.rejects(pollDeviceAuthorization('https://api.blinkhost.me', device, 'synthetic-verifier', h.services), isError(expected));
        assert.equal(h.calls(), 1);
    }
});
test('uncertain network outcome is surfaced without replaying token delivery', async () => {
    const error = new CliError('The BlinkHost API request timed out.', 1, 'request_timeout');
    const h = harness([error]);
    await assert.rejects(pollDeviceAuthorization('https://api.blinkhost.me', device, 'synthetic-verifier', h.services), error);
    assert.equal(h.calls(), 1);
});
test('invalid polling contracts cannot create an unbounded polling loop', async () => {
    for (const changed of [{ expires_in: 0 }, { expires_in: Infinity }, { expires_in: 3601 },
        { interval: 0 }, { interval: NaN }, { interval: 61 }, { interval: 1.5 }, { device_code: '' }]) {
        const h = harness([]);
        await assert.rejects(pollDeviceAuthorization('https://api.blinkhost.me', { ...device, ...changed }, 'synthetic-verifier', h.services), isError('authorization_response_invalid'));
        assert.equal(h.calls(), 0);
        assert.deepEqual(h.waits, []);
    }
});
test('polling retains the five-second floor and does not display unknown server errors', async () => {
    const h = harness([{ status: 500, data: { error: 'sensitive-server-details' } }]);
    await assert.rejects(pollDeviceAuthorization('https://api.blinkhost.me', { ...device, interval: 1 }, 'synthetic-verifier', h.services), error => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'authorization_failed');
        assert.ok(!error.message.includes('sensitive-server-details'));
        return true;
    });
    assert.deepEqual(h.waits, [5000]);
    assert.equal(h.calls(), 1);
});
//# sourceMappingURL=device-flow.test.js.map