import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssistant } from '../assistant.js';
import { validateModuleBuild } from '../module-build.js';
import { moduleBuildPortableFailureGuidance, moduleBuildFailureGuidance } from '../module-build-diagnostics.js';
import { documentationTopic } from '../guidance.js';

const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const review = '597a2b2d-53cb-4396-a021-9be4de0f1af0';
const module = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const receipt = { id: review, project_id: project, module_id: module, revision: digest,
  source_digest: digest, action_digest: digest, expires_at: '2026-09-07T20:00:00Z',
  applied_at: '2026-09-07T19:45:00Z', build_id: module, build_state: 'requested', artifact_id: null,
  usage: { metric: 'preview_builds', quantity: 1, ai_units: 0, policy: 'standard_build_allowance_and_configured_overages' },
  verification: 'build_requested_not_published' };
const portableFacts = { schema_version: 1, stage: 'portable_compilation', resource: 'portable_artifact',
  observed: 10_000_001, limit: 10_000_000, unit: 'bytes', measurement: 'lower_bound' };

const memoryFacts = { schema_version: 1, stage: 'portable_validation', resource: 'guest_memory',
  observed: 134283264, limit: 134217728, unit: 'bytes', measurement: 'declared_memory',
  minimum_memory_bytes: 65536, maximum_memory_bytes: 134283264 };

test('memory rejection receipts validate declarations and suppress arbitrary worker text', () => {
  for (const limit of [134217728, 536870912]) {
    for (const maximum of [null, limit + 65536]) {
      const facts = { ...memoryFacts, limit, observed: limit + 65536,
        minimum_memory_bytes: maximum === null ? limit + 65536 : 65536, maximum_memory_bytes: maximum };
      const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: facts, failure_message: 'private-token' };
      validateModuleBuild(input, { project, review }, 'build-status');
      assert.match(moduleBuildFailureGuidance(input)!, /Reduce the module's initial or maximum memory settings/);
      assert.match(moduleBuildFailureGuidance(input)!, /not measured runtime or compiler memory/);
      assert.doesNotMatch(moduleBuildFailureGuidance(input)!, /private-token|upgrade/i);
    }
  }
  for (const changed of [{ limit: 134217729 }, { observed: '134283264' }, { minimum_memory_bytes: true },
    { minimum_memory_bytes: 65537 }, { maximum_memory_bytes: 0 }, { maximum_memory_bytes: undefined },
    { observed: 134217728, maximum_memory_bytes: 134217728 }, { maximum_memory_bytes: 2 ** 32 + 65536 },
    { observed: Number.MAX_SAFE_INTEGER + 1 }, { measurement: 'runtime_rss' }, { schema_version: true },
    { artifact_sha256: 'private-token' }]) {
    const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: { ...memoryFacts, ...changed } };
    assert.equal(moduleBuildFailureGuidance(input), undefined);
    assert.throws(() => validateModuleBuild(input, { project, review }, 'build-status'));
  }
  for (const changed of [{ build_state: 'succeeded' }, { build_state: 'cancelled' }, { artifact_id: module }, { build_id: module + '\n' }]) {
    const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: memoryFacts, ...changed };
    assert.equal(moduleBuildFailureGuidance(input), undefined);
    assert.throws(() => validateModuleBuild(input, { project, review }, 'build-status'));
  }
});

const packageCodes = ["BHPY_DEPENDENCIES_UNSUPPORTED","BHPY_NATIVE_PACKAGE_UNSUPPORTED","BHPY_UNSUPPORTED_IMPORT","BHPY_DYNAMIC_IMPORT_UNSUPPORTED","BHJS_PACKAGE_MANIFEST","BHJS_LIFECYCLE_SCRIPT_UNSUPPORTED","BHJS_PACKAGE_VERSION_UNCERTIFIED","BHJS_LOCKFILE_REQUIRED","BHJS_LOCKFILE_INVALID","BHJS_NATIVE_ADDON_UNSUPPORTED","BHJS_PACKAGE_UNCERTIFIED","BHJS_NODE_API_UNSUPPORTED","BHJS_EXTERNAL_IMPORT_UNSUPPORTED","BHJS_DYNAMIC_IMPORT_UNSUPPORTED"];
const packageFacts = { schema_version: 1, stage: 'source_compatibility', resource: 'package_compatibility',
  language: 'typescript-wasi', code: 'BHJS_NODE_API_UNSUPPORTED' };

test('package rejection receipts validate closed facts for all compatible languages without granting execution', () => {
  for (const code of packageCodes) {
    for (const language of code.startsWith('BHPY_') ? ['python-wasi'] : ['javascript-wasi', 'typescript-wasi']) {
      const input = { ...receipt, build_state: 'failed_user',
        failure_diagnostic: { ...packageFacts, language, code }, failure_message: 'private-token\u001b[31m' };
      const before = structuredClone(input);
      validateModuleBuild(input, { project, review }, 'build-status');
      assert.match(moduleBuildFailureGuidance(input)!, /build again/);
      assert.doesNotMatch(moduleBuildFailureGuidance(input)!, /private-token|upgrade|\u001b/i);
      assert.deepEqual(input, before);
    }
  }
});

test('package rejection receipts reject malformed facts language mismatches and other build states', () => {
  const changes: Record<string, unknown>[] = [
    { schema_version: true }, { schema_version: '1' }, { stage: 'execution' }, { resource: 'guest_memory' },
    { language: 'python-wasi' }, { language: null }, { code: 'BHJS_UNKNOWN' }, { code: '__proto__' },
    { code: [] }, { code: true }, { secret: 'private-token' },
  ];
  for (const field of Object.keys(packageFacts)) {
    const incomplete: Record<string, unknown> = { ...packageFacts };
    delete incomplete[field];
    const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: incomplete };
    assert.equal(moduleBuildFailureGuidance(input), undefined);
    assert.throws(() => validateModuleBuild(input, { project, review }, 'build-status'));
  }
  for (const changed of changes) {
    const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: { ...packageFacts, ...changed } };
    assert.equal(moduleBuildFailureGuidance(input), undefined);
    assert.throws(() => validateModuleBuild(input, { project, review }, 'build-status'));
  }
  for (const changed of [{ build_state: 'succeeded' }, { build_state: 'cancelled' }, { build_state: 'failed_security' },
    { artifact_id: module }, { build_id: module + '\n' }, { build_id: true }]) {
    const input = { ...receipt, build_state: 'failed_user', failure_diagnostic: packageFacts, ...changed };
    assert.equal(moduleBuildFailureGuidance(input), undefined);
    assert.throws(() => validateModuleBuild(input, { project, review }, 'build-status'));
  }
});

test('build catalog rejects ambiguous or terminal-control metadata', () => {
  const entry = { id: module, name: 'api', language: 'typescript-wasi', build_available: true };
  const catalog = { project_id: project, revision: digest, modules: [entry] };
  validateModuleBuild(catalog, { project }, 'build-modules');
  for (const changed of [{ name: 'api\n' }, { language: 'typescript-wasi\n' },
    { name: '\u001b[31mapi' }, { id: `${module}\n` }, { build_available: 'true' }]) {
    assert.throws(() => validateModuleBuild({ ...catalog, modules: [{ ...entry, ...changed }] }, { project }, 'build-modules'));
  }
  assert.throws(() => validateModuleBuild({ ...catalog, modules: [entry, entry] }, { project }, 'build-modules'));
});

test('catalog and review commands preserve source revision and stable request ID without building', async () => {
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
  const requests: { url: string; method: string; body: unknown }[] = [];
  const prepared = { ...receipt, applied_at: null, build_id: null, build_state: null, verification: 'not_applied' };
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    return new Response(JSON.stringify(init?.method === 'POST' ? prepared : {
      project_id: project, revision: digest, modules: [{ id: module, name: 'api', language: 'typescript-wasi', build_available: true }],
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await runAssistant(['build-modules', '--project', project]);
    await runAssistant(['build-review', '--project', project, '--module', module, '--revision', digest, '--request-id', review]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.method, 'GET');
    assert.equal(requests[1]?.method, 'POST');
    assert.ok(requests[1]?.url.endsWith(`/projects/${project}/module-builds/review/`));
    assert.deepEqual(JSON.parse(String(requests[1]?.body)), { module_id: module, revision: digest, client_request_id: review });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
  }
});

test('build approval requires exact confirmation and rejects bypass options before network', async () => {
  const base = ['build-approve', review, '--project', project, '--digest', digest];
  for (const args of [base, [...base, '--confirm', project], [...base, '--confirm', review, '--force'],
    [...base, '--confirm', review, '--publish'], ['build-review', '--project', project, '--module', module]]) {
    await assert.rejects(runAssistant(args));
  }
  assert.ok(documentationTopic('ai')?.usage.some(line => line.includes('ai build-approve')));
});

test('build responses reject changed scope, charges and unknown state', () => {
  const expected = { project, review, digest };
  validateModuleBuild(receipt, expected, 'build-approve');
  for (const changed of [{ project_id: module }, { id: project }, { action_digest: 'b'.repeat(64) },
    { build_state: 'deployed' }, { usage: { ...receipt.usage, quantity: 2 } },
    { applied_at: null, verification: 'not_applied', build_id: null, build_state: null }]) {
    assert.throws(() => validateModuleBuild({ ...receipt, ...changed }, expected, 'build-approve'), /could not be verified/);
  }
  validateModuleBuild({ ...receipt, build_id: null, build_state: null }, expected, 'build-status');
  for (const state of ['provisioning', 'signing', 'succeeded', 'failed_platform', 'failed_user', 'failed_security', 'rejected']) {
    validateModuleBuild({ ...receipt, build_state: state }, expected, 'build-status');
  }
});

test('build CLI sends one exact approval and reads status without replay', async () => {
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
  const requests: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    return new Response(JSON.stringify(receipt), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const args = ['build-approve', review, '--project', project, '--digest', digest, '--confirm', review];
    const result = await runAssistant(args);
    assert.match(result.message, /not published/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, 'POST');
    assert.ok(requests[0]?.url.endsWith(`/projects/${project}/module-builds/reviews/${review}/apply/`));
    assert.deepEqual(JSON.parse(String(requests[0]?.body)), { action_digest: digest });
    await runAssistant(['build-status', review, '--project', project]);
    assert.equal(requests[1]?.method, 'GET');
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error('synthetic lost response'); };
    await assert.rejects(runAssistant(args));
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
  }
});

test('build status accepts closed lower-bound facts across admitted portable profiles', () => {
  for (const limit of [10_000_000, 20_000_000, 40_000_000, 80_000_000]) {
    const failed = { ...receipt, build_state: 'failed_user',
      failure_diagnostic: { ...portableFacts, observed: limit + 1, limit } };
    validateModuleBuild(failed, { project, review }, 'build-status');
    assert.match(moduleBuildPortableFailureGuidance(failed)!, new RegExp(`at least ${limit + 1} bytes`));
    assert.ok(!moduleBuildPortableFailureGuidance(failed)!.toLowerCase().includes('upgrade'));
  }
  validateModuleBuild({ ...receipt, failure_diagnostic: null }, { project, review }, 'build-status');
  validateModuleBuild(receipt, { project, review }, 'build-status');
});

test('build status rejects changed or unbounded facts and inconsistent outcomes', () => {
  const failed = { ...receipt, build_state: 'failed_user', failure_diagnostic: portableFacts };
  for (const changed of [{ schema_version: true }, { stage: 'native_preparation' }, { resource: '\u001b[31mprivate' },
    { measurement: 'exact' }, { unit: 'MiB' }, { observed: true }, { observed: 10_000_000 },
    { observed: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 80_000_001, observed: 80_000_002 },
    { message: 'private-worker-text' }, { build_id: module }]) {
    const value = { ...failed, failure_diagnostic: { ...portableFacts, ...changed } };
    assert.throws(() => validateModuleBuild(value, { project, review }, 'build-status'), /could not be verified/);
    assert.equal(moduleBuildPortableFailureGuidance(value), undefined);
  }
  for (const changed of [{ build_state: 'succeeded' }, { build_state: 'failed_platform' }, { artifact_id: module },
    { build_id: null, build_state: null }, { failure_diagnostic: 'private-worker-text' },
    { failure_diagnostic: [] }]) {
    assert.throws(() => validateModuleBuild({ ...failed, ...changed }, { project, review }, 'build-status'));
  }
});

test('build status shows safe size guidance using one GET and no automatic build retry', async () => {
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
  const requests: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    return new Response(JSON.stringify({ ...receipt, build_state: 'failed_user', failure_diagnostic: portableFacts }),
      { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runAssistant(['build-status', review, '--project', project]);
    assert.match(result.message, /Backend module build failed/);
    assert.match(result.message, /at least 10000001 bytes; its admitted maximum is 10000000 bytes/);
    assert.match(result.message, /Reduce bundled code or dependencies/);
    assert.deepEqual(requests.map(request => request.method), ['GET']);
    assert.equal(requests[0]?.body, undefined);
    assert.ok(requests[0]?.url.endsWith(`/projects/${project}/module-builds/reviews/${review}/`));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
  }
});
