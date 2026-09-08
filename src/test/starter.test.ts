import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssistant } from '../assistant.js';
import { validateStarter } from '../starter.js';
import { documentationTopic } from '../guidance.js';

const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const review = '597a2b2d-53cb-4396-a021-9be4de0f1af0';
const moduleId = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const language = { id: 'typescript-wasi', label: 'TypeScript', status: 'ga' };
const catalog = { project_id: project, revision: digest, verification: 'starter_only', languages: [language] };
const file = { path: '_server_islands/api/main.ts', content: 'export default {};', managed: false };
const prepared = { id: review, project_id: project, name: 'api', language: language.id,
  revision: digest, action_digest: digest, expires_at: '2026-09-08T10:00:00Z', template_current: true,
  files: [file], applied_at: null, applied_revision: '', module_id: null, verification: 'not_applied' };
const receipt = { ...prepared, applied_at: '2026-09-08T09:50:00Z', applied_revision: 'b'.repeat(64),
  module_id: moduleId, verification: 'source_saved_not_built' };

test('starter catalog validates exact scope, bounded language metadata and availability', () => {
  validateStarter(catalog, { project }, 'starters');
  for (const changed of [{ project_id: review }, { revision: `${digest}\n` }, { verification: 'built' },
    { languages: [language, language] }, { languages: null }, { languages: [{ ...language, status: 'unknown' }] },
    { languages: [{ ...language, label: '\u001b[31mTypeScript' }] }, { languages: [{ ...language, id: 'nodejs' }] }]) {
    assert.throws(() => validateStarter({ ...catalog, ...changed }, { project }, 'starters'));
  }
});

test('starter review binds reviewed source and refuses unsafe paths or ambiguous receipts', () => {
  const expected = { project, review, name: 'api', language: language.id, revision: digest, digest };
  validateStarter(prepared, expected, 'starter-review');
  validateStarter(receipt, expected, 'starter-approve');
  for (const changed of [{ project_id: review }, { id: project }, { action_digest: 'c'.repeat(64) },
    { name: 'other' }, { language: 'rust-wasi' }, { revision: 'c'.repeat(64) }, { expires_at: 'invalid' },
    { applied_revision: '' }, { verification: 'published' }, { module_id: 'invalid' },
    { files: [] }, { files: [file, file] }, { template_current: false }]) {
    assert.throws(() => validateStarter({ ...receipt, ...changed }, expected, 'starter-approve'));
  }
  for (const path of ['../secret', '_server_islands/other/main.ts', '_server_islands/api/../secret',
    '_server_islands/api//main.ts', '_server_islands/api/a\\b', '_server_islands/api/a\n', '_server_islands/api/a:b']) {
    assert.throws(() => validateStarter({ ...prepared, files: [{ ...file, path }] }, expected, 'starter-review'));
  }
  assert.throws(() => validateStarter({ ...prepared, files: [{ ...file, content: '🌍'.repeat(20000) }] }, expected, 'starter-review'));
  assert.throws(() => validateStarter(prepared, expected, 'starter-approve'));
  // Withdrawn templates and deleted modules preserve historical receipts, not source.
  validateStarter({ ...receipt, template_current: false, files: [], module_id: null }, expected, 'starter-status');
});

test('starter mutations require review bindings and refuse force, publish and malformed input before network', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not reach network'); };
  const base = ['starter-approve', review, '--project', project, '--digest', digest];
  try {
    for (const args of [base, [...base, '--confirm', project], [...base, '--confirm', review, '--force'],
      [...base, '--confirm', review, '--publish'], ['starter-review', '--project', project],
      ['starter-review', '--project', project, '--name', '../api', '--language', language.id, '--revision', digest, '--request-id', review]]) {
      await assert.rejects(runAssistant(args));
    }
    assert.equal(calls, 0);
    assert.ok(documentationTopic('ai')?.usage.some(line => line.includes('ai starter-approve')));
  } finally { globalThis.fetch = original; }
});

test('CLI starter lifecycle makes only canonical scoped requests and never replays a lost save', async () => {
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
  const requests: { url: string; method: string; body: unknown }[] = [];
  let value: unknown = catalog;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const approve = ['starter-approve', review, '--project', project, '--digest', digest, '--confirm', review];
  try {
    await runAssistant(['starters', '--project', project]);
    value = prepared;
    await runAssistant(['starter-review', '--project', project, '--name', 'api', '--language', language.id,
      '--revision', digest, '--request-id', review]);
    assert.deepEqual(JSON.parse(String(requests[1]?.body)), { name: 'api', language: language.id, revision: digest, client_request_id: review });
    value = receipt;
    assert.match((await runAssistant(approve)).message, /not built or published/);
    await runAssistant(['starter-status', review, '--project', project]);
    assert.deepEqual(requests.map(r => r.method), ['GET', 'POST', 'POST', 'GET']);
    assert.ok(requests[2]?.url.endsWith(`/projects/${project}/starters/reviews/${review}/apply/`));
    assert.deepEqual(JSON.parse(String(requests[2]?.body)), { action_digest: digest });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('synthetic response loss'); };
    await assert.rejects(runAssistant(approve));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
  }
});
