import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../api.js';
import { designArguments, runDesign } from '../design.js';

test('design search resolves the authorized project workspace and makes a scoped read', async () => {
  const project = '11111111-1111-4111-8111-111111111111';
  const originalCreate = ApiClient.create;
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  ApiClient.create = async () => ApiClient.fromAccessToken('test', { apiOrigin: 'https://api.blinkhost.me' }, 'synthetic');
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init); requests.push(request);
    return Response.json(request.url.endsWith(`/sites/${project}/`)
      ? { id: project, organization: 42 } : { references: [] });
  };
  try {
    assert.deepEqual(await runDesign(['search', 'agency cards', '--project', project]), { references: [] });
    assert.equal(requests.length, 2);
    const search = requests[1];
    assert.ok(search);
    assert.equal(search.headers.get('x-organization-id'), '42');
    assert.equal(search.method, 'POST');
    assert.equal(search.url.includes('agency'), false);
    assert.equal((await search.json()).design_query, 'agency cards');
    globalThis.fetch = async () => Response.json({ id: project, organization: null });
    await assert.rejects(runDesign(['list', '--project', project]), { code: 'project_workspace_unavailable' });
    assert.throws(() => designArguments(['search', 'cards', '--project', project, '--limit', '9']), { code: 'design_limit_invalid' });
  } finally { ApiClient.create = originalCreate; globalThis.fetch = originalFetch; }
});
