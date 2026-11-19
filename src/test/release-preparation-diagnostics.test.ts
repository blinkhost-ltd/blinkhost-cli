import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { ApiClient } from '../api.js';
import { CliError, EXIT } from '../errors.js';
import { runRemote } from '../remote.js';
import {
  loadReleasePreparationDiagnostics, parseReleasePreparationDiagnostics as parse,
  readPreparationDiagnosticsResponse, type PreparationRelease,
} from '../release-preparation-diagnostics.js';

const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/customer-release-failure-v1.json', import.meta.url), 'utf8'));
const nativePolicy = { worker_profile: {
  worker_memory_bytes: 8 * 1024 ** 3, native_stage_aggregate_cpu_seconds: 720, native_stage_wall_seconds: 720,
} };
const resources = {
  native_stage_aggregate_cpu_seconds: 600, native_stage_wall_seconds: 600,
  native_bundle_minimum_bytes: 64 * 1024 ** 2, native_bundle_ceiling_bytes: 512 * 1024 ** 2,
  native_expansion_multiplier: 4,
};
const release: PreparationRelease = fixture.release;
const envelope = fixture.response;
const attempt = envelope.attempts[0];
const memory = attempt.failure_diagnostic;
const project = release.environment.root_project_id;
const changed = '55555555-5555-4555-8555-555555555555';
const client = () => ApiClient.fromAccessToken('test', { apiOrigin: 'https://example.invalid' }, 'synthetic-test-token');
const withDiagnostic = (diagnostic: unknown) => ({ ...envelope, attempts: [{ ...attempt, failure_diagnostic: diagnostic }] });

test('the representative customer API response becomes detached safe prose, with no serving or plan authority', () => {
  const input = structuredClone(envelope);
  const result = parse(input, release)!;
  assert.equal(result.state, 'available');
  assert.equal(result.attempts.length, 1);
  assert.match(result.attempts[0]!.explanation, /sampled worker peak was 4096 bytes/);
  assert.match(result.attempts[0]!.explanation, /Changing plans does not increase/);
  assert.equal('serving_readiness' in result, false);
  assert.deepEqual(input, envelope);
  input.attempts[0].module_name = 'changed';
  assert.equal(result.attempts[0]!.moduleName, 'api');
});

test('worker memory, aggregate CPU, deadline and generic failure agree with the pinned platform contract', () => {
  assert.equal(memory.limit, nativePolicy.worker_profile.worker_memory_bytes);
  assert.ok(parse(withDiagnostic({ ...memory, observed: null, measurement: 'unavailable' }), release));
  const cpu = nativePolicy.worker_profile.native_stage_aggregate_cpu_seconds * 1e9;
  for (const observed of [cpu + 123456789, null]) {
    const facts = { ...memory, code: 'native_preparation_cpu_exceeded', resource: 'compiler_cpu',
      unit: 'nanoseconds', limit: cpu, observed, measurement: observed === null ? 'unavailable' : 'sampled_aggregate' };
    const text = parse(withDiagnostic(facts), release)!.attempts[0]!.explanation;
    assert.match(text, /720-second aggregate CPU allowance/);
    if (observed !== null) assert.match(text, /720\.123456789 seconds/);
    else assert.doesNotMatch(text, /sampled aggregate CPU time/);
  }
  assert.match(parse(withDiagnostic({ ...memory, code: 'native_preparation_deadline_exceeded',
    resource: 'compiler_wall_time', unit: 'seconds', limit: nativePolicy.worker_profile.native_stage_wall_seconds,
    observed: null, measurement: 'unavailable' }), release)!.attempts[0]!.explanation, /preparation deadline/);
  assert.match(parse(withDiagnostic({ ...memory, code: 'native_preparation_child_failed',
    resource: null, unit: null, limit: null, observed: null, measurement: 'unavailable' }), release)!.attempts[0]!.explanation,
  /could not finish/);
});

test('current 600-second worker failures and historical 720-second failures retain their exact policies', () => {
  assert.equal(resources.native_stage_aggregate_cpu_seconds, 600);
  assert.equal(resources.native_stage_wall_seconds, 600);
  for (const [schema_version, seconds] of [[1, 720], [2, 600]] as const) {
    const cpu = { ...memory, schema_version, code: 'native_preparation_cpu_exceeded',
      resource: 'compiler_cpu', unit: 'nanoseconds', limit: seconds * 1e9,
      observed: seconds * 1e9 + 1, measurement: 'sampled_aggregate' };
    const deadline = { ...memory, schema_version, code: 'native_preparation_deadline_exceeded',
      resource: 'compiler_wall_time', unit: 'seconds', limit: seconds,
      observed: null, measurement: 'unavailable' };
    assert.match(parse(withDiagnostic(cpu), release)!.attempts[0]!.explanation,
      new RegExp(`${seconds}-second aggregate CPU allowance`));
    assert.match(parse(withDiagnostic(cpu), release)!.attempts[0]!.explanation,
      new RegExp(`${seconds}\\.000000001 seconds`));
    assert.match(parse(withDiagnostic(deadline), release)!.attempts[0]!.explanation,
      new RegExp(`${seconds}-second preparation deadline`));
    for (const facts of [cpu, deadline]) {
      assert.equal(parse(withDiagnostic({ ...facts, schema_version: schema_version === 1 ? 2 : 1 }), release), undefined);
      for (const invalid of [null, true, '2', 0, 3, [], {}]) {
        assert.equal(parse(withDiagnostic({ ...facts, schema_version: invalid }), release), undefined);
      }
    }
    assert.equal(parse(withDiagnostic({ ...cpu, observed: cpu.limit }), release), undefined);
    assert.ok(parse(withDiagnostic({ ...cpu, observed: null, measurement: 'unavailable' }), release));
  }
  assert.ok(parse(withDiagnostic({ ...memory, schema_version: 2 }), release));
  const output = { ...memory, schema_version: 2, code: 'native_output_budget_exceeded',
    resource: 'native_artifact', unit: 'bytes', limit: resources.native_bundle_minimum_bytes,
    observed: resources.native_bundle_minimum_bytes + 1, portable_size_bytes: attempt.portable_size_bytes,
    measurement: 'measured_size' };
  assert.equal(parse(withDiagnostic(output), release), undefined);
});

test('native output guidance derives from the signed portable module size across all artifact profiles', () => {
  for (const size of [9, 20_000_000, 50_000_000, 80_000_000]) {
    const limit = Math.min(resources.native_bundle_ceiling_bytes,
      Math.max(resources.native_bundle_minimum_bytes, resources.native_expansion_multiplier * size));
    const expected = { ...release, backend_modules_snapshot: [{ ...release.backend_modules_snapshot[0]!, artifact_size_bytes: size }] };
    const facts = { ...memory, code: 'native_output_budget_exceeded', resource: 'native_artifact',
      unit: 'bytes', limit, observed: limit + 1, portable_size_bytes: size, measurement: 'measured_size' };
    const input = { ...envelope, attempts: [{ ...attempt, portable_size_bytes: size, failure_diagnostic: facts }] };
    assert.match(parse(input, expected)!.attempts[0]!.explanation, new RegExp(`${limit}-byte output budget`));
    for (const mutation of [{ portable_size_bytes: size + 1 }, { limit: limit + 1 }, { observed: limit }]) {
      assert.equal(parse({ ...input, attempts: [{ ...input.attempts[0], failure_diagnostic: { ...facts, ...mutation } }] }, expected), undefined);
    }
  }
});

test('empty available and unavailable histories never become readiness claims', () => {
  for (const state of ['available', 'unavailable']) {
    assert.deepEqual(parse({ ...envelope, state, attempts: [] }, release), { state, attempts: [], truncated: false });
  }
  assert.equal(parse({ ...envelope, state: 'unavailable' }, release), undefined);
  assert.equal(parse({ ...envelope, state: 'unavailable', attempts: [], truncated: true }, release), undefined);
});

test('cross-release, project and registry substitutions or injected companion text fail closed', () => {
  for (const mutation of [{ deployment_id: '78' }, { deployment_id: release.id + '\n' }, { deployment_id: Number(release.id) },
    { project_id: changed }, { release_digest: 'd'.repeat(64) }, { backend_modules_digest: 'd'.repeat(64) },
    { kind: 'current_module_status' }, { serving_readiness: 'ready' }, { state: 'active' }, { schema_version: true },
    { truncated: 1 }, { attempts: 'private-secret' }, { message: 'private-secret' }, { compiler_stderr: 'private-secret' }]) {
    assert.equal(parse({ ...envelope, ...mutation }, release), undefined);
  }
  for (const mutation of [{ state: 'ready' }, { module_id: changed }, { module_name: '\u001b[31mprivate-secret' },
    { portable_sha256: 'e'.repeat(64) }, { portable_size_bytes: 10 }, { project_id: changed },
    { release_digest: 'e'.repeat(64) }, { preparation_id: attempt.preparation_id + '\n' }, { request_id: true },
    { recorded_at: '2026-99-99T10:00:00Z' }, { recorded_at: attempt.recorded_at + '\n' },
    { schema_version: true }, { message: 'private-secret' }]) {
    assert.equal(parse({ ...envelope, attempts: [{ ...attempt, ...mutation }] }, release), undefined);
  }
});

test('malformed numbers, guessed policy, guest-memory claims and arbitrary compiler text never reach prose', () => {
  for (const mutation of [{ schema_version: true }, { stage: 'portable_compilation' }, { code: 'private-secret' },
    { responsibility: 'customer' }, { remediation: 'upgrade_plan' }, { resource: 'guest_memory' }, { unit: 'MiB' },
    { limit: true }, { limit: memory.limit + 1 }, { observed: true }, { observed: '4096' },
    { observed: NaN }, { observed: Infinity }, { observed: Number.MAX_SAFE_INTEGER + 1 }, { observed: -1 },
    { measurement: 'measured_size' }, { compiler_stderr: 'private-secret' }, { message: 'private-secret' }]) {
    assert.equal(parse(withDiagnostic({ ...memory, ...mutation }), release), undefined);
  }
  for (const diagnostic of [null, [], true, 'private-secret']) assert.equal(parse(withDiagnostic(diagnostic), release), undefined);
  assert.equal(parse(withDiagnostic({ ...memory, code: 'native_preparation_cpu_exceeded', resource: 'compiler_cpu',
    unit: 'nanoseconds', limit: 720e9, observed: 720e9, measurement: 'sampled_aggregate' }), release), undefined);
});

test('oversized histories, duplicate identities and invalid registry sizes fail closed', () => {
  assert.equal(parse({ ...envelope, attempts: Array(51).fill(attempt) }, release), undefined);
  assert.equal(parse({ ...envelope, attempts: [attempt, attempt] }, release), undefined);
  assert.equal(parse({ ...envelope, attempts: [attempt, { ...attempt, preparation_id: changed }] }, release), undefined);
  const artifact = release.backend_modules_snapshot[0]!;
  for (const snapshot of [Array(101).fill(artifact), [artifact, artifact], [{ ...artifact, artifact_size_bytes: true }]]) {
    assert.equal(parse(envelope, { ...release, backend_modules_snapshot: snapshot }), undefined);
  }
});

test('explicit CLI inspection sends exactly two scoped GETs and returns only safe historical explanations', async () => {
  const original = globalThis.fetch;
  const token = process.env.BLINKHOST_ACCESS_TOKEN;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-test-token';
  const calls: Request[] = [];
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init); calls.push(request);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-test-token');
    assert.equal(request.headers.get('idempotency-key'), null);
    return Response.json(calls.length === 1 ? { ...release, compiler_stderr: 'private-secret' } : envelope);
  };
  try {
    const result = await runRemote('deployments', ['preparation-diagnostics', release.id, '--project', project]);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
      `/api/deployments/${release.id}/`, `/api/deployments/${release.id}/preparation-diagnostics/`,
    ]);
    assert.match(JSON.stringify(result), /Past preparation failures/);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|failure_diagnostic|serving_readiness/);
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = token;
  }
});

test('invalid scope and mutation options fail before authentication or a network call', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    for (const args of [[], ['0', '--project', project], [release.id], [release.id, '--project', project + '\n'],
      [release.id + '\n', '--project', project], [release.id, '--project', project, '--query', 'state=ready'],
      [release.id, '--project', project, '--data', '{"activate":true}'], [release.id, '--project', project, 'retry']]) {
      await assert.rejects(runRemote('deployments', ['preparation-diagnostics', ...args]), error => {
        assert.ok(error instanceof CliError); assert.equal(error.exitCode, EXIT.usage); return true;
      });
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('wrong release detail stops inspection before fetching history, and changed history stops without retry', async () => {
  const original = globalThis.fetch;
  try {
    for (const detail of [{ ...release, id: '78' }, { ...release, environment: { root_project_id: changed } },
      { ...release, backend_modules_snapshot: null }]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json(detail); };
      await assert.rejects(loadReleasePreparationDiagnostics(client(), release.id, project), { code: 'preparation_diagnostics_unavailable' });
      assert.equal(calls, 1);
    }
    for (const history of [{ ...envelope, project_id: changed }, { ...envelope, serving_readiness: 'ready' }]) {
      let calls = 0;
      globalThis.fetch = async () => Response.json(++calls === 1 ? release : history);
      await assert.rejects(loadReleasePreparationDiagnostics(client(), release.id, project), { code: 'preparation_diagnostics_unavailable' });
      assert.equal(calls, 2);
    }
  } finally { globalThis.fetch = original; }
});

test('HTTP denial cancels its body unread and retains only a safe request identity', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 404, 409, 500, 503]) {
      let cancelled = false; let calls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull() { throw new Error('private-secret body must stay unread'); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      globalThis.fetch = async () => { calls++; return new Response(body, {
        status, headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'private-secret\u001b[31m' },
      }); };
      await assert.rejects(loadReleasePreparationDiagnostics(client(), release.id, project), error => {
        assert.ok(error instanceof CliError); assert.equal(error.code, `api_${status}`);
        assert.doesNotMatch(JSON.stringify(error), /private-secret|\u001b/);
        assert.match(error.details[0]!, /^Request ID: [0-9a-f-]{36}$/); return true;
      });
      assert.equal(calls, 1); assert.equal(cancelled, true);
    }
  } finally { globalThis.fetch = original; }
});

test('bounded JSON transport accepts split UTF-8 and rejects oversize, mismatched length or invalid encoding', async () => {
  const bytes = new TextEncoder().encode('{"ok":"\u00e9"}');
  const split = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } });
  assert.deepEqual(await readPreparationDiagnosticsResponse(new Response(split,
    { headers: { 'Content-Type': 'Application/JSON; charset=utf-8', 'Content-Length': String(bytes.length) } }), 128), { ok: '\u00e9' });
  for (const response of [new Response('{}', { headers: { 'Content-Type': 'text/plain' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '129' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }),
    new Response(' '.repeat(129), { headers: { 'Content-Type': 'application/json' } }),
    new Response(Uint8Array.of(0xff), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(readPreparationDiagnosticsResponse(response, 128), { code: 'preparation_diagnostics_unavailable' });
    assert.equal(response.body?.locked, false);
  }
});

test('zero-byte chunk floods are bounded and cancelled instead of keeping the terminal busy', async () => {
  let reads = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(readPreparationDiagnosticsResponse(response, 128), { code: 'preparation_diagnostics_unavailable' });
  assert.equal(reads, 1024); assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test('loopback HTTP interruption returns unavailable details with no third request or activation', async t => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (requests.length === 1) { response.end(JSON.stringify(release)); return; }
    response.setHeader('Content-Length', '100');
    response.write('{');
    setImmediate(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const local = ApiClient.fromAccessToken('loopback', { apiOrigin: `http://127.0.0.1:${address.port}` }, 'synthetic-test-token');
  await assert.rejects(loadReleasePreparationDiagnostics(local, release.id, project), error => {
    assert.ok(error instanceof CliError); assert.match(error.message, /unavailable for this release/); return true;
  });
  assert.deepEqual(requests, [`GET /api/deployments/${release.id}/`, `GET /api/deployments/${release.id}/preparation-diagnostics/`]);
});
