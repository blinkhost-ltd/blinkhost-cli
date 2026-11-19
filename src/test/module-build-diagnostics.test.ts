import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../api.js';
import { CliError, EXIT } from '../errors.js';

const origin = 'https://api.blinkhost.me';
const base = '/api/idam/projects/11111111-1111-4111-8111-111111111111/module-builds/';
const review = '22222222-2222-4222-8222-222222222222';
const path = `${base}reviews/${review}/apply/`;
const sourceLimit = {
  schema_version: 1, stage: 'source_admission', resource: 'source_expanded_bytes',
  observed: 10485761, limit: 10485760, unit: 'bytes', measurement: 'lower_bound',
};
const payload = { code: 'build_authorization_changed', source_limit: sourceLimit,
  detail: 'private-secret.py\x1b[31m', plan: 'secret-plan', path: '/private/source' };
const client = ApiClient.fromAccessToken('test', { apiOrigin: origin }, 'synthetic-test-token');

async function rejected(response: () => Response | Promise<Response>, expected: string, status = 409, endpoint = path): Promise<void> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const request = new Request(url, init);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-test-token');
    assert.equal(request.headers.get('idempotency-key'), 'synthetic-build-intent');
    return response();
  };
  try {
    await assert.rejects(client.request(endpoint, { method: 'POST', body: '{"action_digest":"synthetic"}',
      headers: { 'Idempotency-Key': 'synthetic-build-intent', 'X-Request-ID': 'synthetic-request' } }), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, `api_${status}`);
      assert.equal(error.exitCode, status === 409 ? EXIT.conflict : [401, 403].includes(status) ? EXIT.auth : EXIT.remote);
      assert.equal(error.message, expected);
      assert.deepEqual(error.details, ['Request ID: synthetic-request']);
      assert.doesNotMatch(JSON.stringify(error), /private|secret|\u001b/);
      return true;
    });
    assert.equal(calls, 1, 'displaying rejection never resubmits the reviewed build');
  } finally { globalThis.fetch = original; }
}

test('reviewed build displays bounded source admission facts without server detail or plan advice', async () => {
  const message = 'Backend module source contains at least 10485761 bytes; the maximum is 10485760 bytes. Reduce the source size or file count and try again.';
  for (const endpoint of [base, `${base}review/`, `${base}reviews/${review}/`, path]) {
    await rejected(() => Response.json(payload, { status: 409, headers: { 'x-request-id': 'private/path\x1b[31m' } }), message, 409, endpoint);
  }
});

const buildLimit = { schema_version: 1, stage: 'build_admission', resource: 'concurrent_builds',
  scope: 'workspace', observed: 2, limit: 2, unit: 'builds', measurement: 'occupied_slots_snapshot' };
const quotaPayload = { ...payload, code: 'concurrent_build_limit_reached', build_limit: buildLimit };

test('reviewed build displays workspace build occupancy without automatically retrying', async () => {
  for (const observed of [2, 3]) {
    await rejected(() => Response.json({ ...quotaPayload, build_limit: { ...buildLimit, observed } }, { status: 409 }),
      `This workspace had ${observed} occupied build slots when this build was rejected; its concurrent-build limit is 2. `
      + 'Wait for an existing build to stop, then retry. This limit applies to builds, not backend requests.');
  }
});

test('zero concurrent build quota explains disabled access without invented usage or upgrade guidance', async () => {
  await rejected(() => Response.json({ ...quotaPayload, build_limit: { ...buildLimit, observed: 0, limit: 0 } }, { status: 409 }),
    'This workspace had 0 occupied build slots when this build was rejected; its concurrent-build limit is 0. '
    + 'Builds are disabled by this workspace\'s current concurrent-build limit. Check workspace build access before trying again. '
    + 'This limit applies to builds, not backend requests.');
});

test('quota schema rejects unknown fields, missing facts, wrong labels and unsafe measurements', async () => {
  for (const change of [{ schema_version: 2 }, { stage: 'execution' }, { resource: 'requests' },
    { scope: 'project' }, { unit: 'requests/second' }, { measurement: 'live' },
    { observed: true }, { observed: '2' }, { observed: 1 }, { observed: Number.MAX_SAFE_INTEGER + 1 },
    { observed: 2.5 }, { limit: -1 }, { limit: false }, { limit: '2' }, { filename: 'private-secret' }]) {
    await rejected(() => Response.json({ ...quotaPayload, build_limit: { ...buildLimit, ...change } }, { status: 409 }),
      'BlinkHost returned HTTP 409.');
  }
  for (const field of Object.keys(buildLimit)) {
    const incomplete: Record<string, unknown> = { ...buildLimit };
    delete incomplete[field];
    await rejected(() => Response.json({ ...quotaPayload, build_limit: incomplete }, { status: 409 }), 'BlinkHost returned HTTP 409.');
  }
  await rejected(() => Response.json({ ...quotaPayload, code: 'permission_denied' }, { status: 409 }), 'BlinkHost returned HTTP 409.');
});

test('quota facts cannot reinterpret authentication, unavailable or unrelated endpoint errors', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    await rejected(() => Response.json(quotaPayload, { status }), `BlinkHost returned HTTP ${status}.`, status);
  }
  await rejected(() => Response.json({ code: quotaPayload.code, build_limit: buildLimit }, { status: 409 }),
    'BlinkHost returned HTTP 409.', 409, '/api/unrelated/');
});

test('collection count and archive attempted-write guidance preserve exact measurement meanings', async () => {
  for (const [code, facts, message] of [
    ['module_source_file_limit', { ...sourceLimit, stage: 'source_collection', resource: 'source_files', observed: 3, limit: 2, unit: 'files', measurement: 'exact' },
      'Backend module source contains 3 files; the maximum is 2 files. Reduce the source size or file count and try again.'],
    ['module_source_archive_too_large', { ...sourceLimit, stage: 'source_archive', resource: 'source_archive_bytes', observed: 13, limit: 10, measurement: 'attempted_write' },
      'Backend module source archive would contain at least 13 bytes; the maximum is 10 bytes. Reduce the source size or file count and try again.'],
  ] as const) {
    await rejected(() => Response.json({ ...payload, code, source_limit: facts }, { status: 409 }), message);
  }
});

test('malformed measurements, wrong codes, unknown labels and invalid stage combinations stay generic', async () => {
  const rows = [null, [], { ...sourceLimit, observed: '10485761' }, { ...sourceLimit, limit: true },
    { ...sourceLimit, observed: Number.MAX_SAFE_INTEGER + 1 }, { ...sourceLimit, observed: sourceLimit.limit },
    { ...sourceLimit, limit: 0 }, { ...sourceLimit, resource: '__proto__' }, { ...sourceLimit, unit: 'MiB' },
    { ...sourceLimit, stage: 'secret-stage' }, { ...sourceLimit, measurement: 'attempted_write' },
    { ...sourceLimit, schema_version: 2 }, { ...sourceLimit, stage: 'source_collection', resource: 'source_archive_bytes' }];
  for (const source_limit of rows) {
    await rejected(() => Response.json({ ...payload, source_limit }, { status: 409 }), 'BlinkHost returned HTTP 409.');
  }
  await rejected(() => Response.json({ ...payload, code: 'different_code' }, { status: 409 }), 'BlinkHost returned HTTP 409.');
});

test('auth, invalid input and unconfirmed HTTP responses never claim a source limit', async () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    await rejected(() => Response.json(payload, { status }), `BlinkHost returned HTTP ${status}.`, status);
  }
});

test('oversized, malformed UTF-8, HTML and mismatched-length error bodies stay bounded and generic', async () => {
  const headers = { 'content-type': 'application/json' };
  for (const response of [
    () => new Response('x'.repeat(2049), { status: 409, headers }),
    () => new Response(new Uint8Array([0xff]), { status: 409, headers }),
    () => new Response('<script>private-secret.py</script>', { status: 409, headers: { 'content-type': 'text/html' } }),
    () => new Response(JSON.stringify(payload), { status: 409, headers: { ...headers, 'content-length': '1' } }),
    () => new Response(JSON.stringify(payload), { status: 409, headers: { ...headers, 'content-length': '2049' } }),
    () => new Response('{invalid-json', { status: 409, headers }),
  ]) await rejected(response, 'BlinkHost returned HTTP 409.');
});

test('empty-chunk streams stop at the read bound and cancellation acknowledgement cannot stall display', async () => {
  let reads = 0;
  let cancelled = false;
  await rejected(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 }), { status: 409, headers: { 'content-type': 'application/json' } }), 'BlinkHost returned HTTP 409.');
  assert.equal(reads, 64);
  assert.equal(cancelled, true);
});

test('broken rejection streams retain the confirmed HTTP status and do not retry', async () => {
  await rejected(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('private-secret')); },
  }), { status: 409, headers: { 'content-type': 'application/json' } }), 'BlinkHost returned HTTP 409.');
});

test('successful build responses remain unchanged and lost acknowledgements are single attempts', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ state: 'queued', review_id: review }); };
    assert.deepEqual(await client.request(path, { method: 'POST' }), { state: 'queued', review_id: review });
    globalThis.fetch = async () => { calls++; throw new TypeError('private-lost-response'); };
    await assert.rejects(client.request(path, { method: 'POST' }), { code: 'network_error', message: 'The BlinkHost API could not be reached.' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
