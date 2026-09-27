import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../errors.js';
import { runRemote } from '../remote.js';

const key = 'release-20260927-request-1';
const operation = '60c9897e-64cb-4a13-a9e6-b14142d2e168';

test('publication requires a saved valid key before authentication or network access', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected network'); };
  try {
    for (const action of ['activate', 'retry', 'rollback', 'promote']) {
      for (const args of [[], ['--idempotency-key', 'short'], ['--idempotency-key', 'unsafe key'], ['--idempotency-key', 'a'.repeat(129)]]) {
        await assert.rejects(runRemote('deployments', ['action', '246', action, ...args]), { code: 'publication_key_required' });
      }
    }
  } finally { globalThis.fetch = original; }
});

test('lost response retains key and recovery only reads the original operation', async () => {
  const original = globalThis.fetch;
  const token = process.env.BLINKHOST_ACCESS_TOKEN;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-publication-token';
  const calls: Array<{ path: string; method: string; key: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const call = { path: new URL(String(url)).pathname, method: init?.method || 'GET', key: new Headers(init?.headers).get('Idempotency-Key') };
    calls.push(call);
    if (call.method === 'POST') throw new TypeError('synthetic lost response after commit');
    return Response.json({ id: operation, state: 'accepted' });
  };
  try {
    await assert.rejects(runRemote('deployments', ['action', '246', 'promote', '--idempotency-key', key]), error => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'network_error');
      assert.match(error.details.join('\n'), new RegExp(`publication-lookup --idempotency-key ${key}`));
      return true;
    });
    assert.deepEqual(await runRemote('deployments', ['publication-lookup', '--idempotency-key', key]), { id: operation, state: 'accepted' });
    await runRemote('deployments', ['publication-status', operation]);
    assert.deepEqual(calls, [
      { path: '/api/deployments/246/promote/', method: 'POST', key },
      { path: '/api/deployment-publications/lookup/', method: 'GET', key },
      { path: `/api/deployment-publications/${operation}/`, method: 'GET', key: null },
    ]);
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = token;
  }
});

test('publication preserves explicit identity across repeated commands and returns it in JSON', async () => {
  const original = globalThis.fetch;
  const token = process.env.BLINKHOST_ACCESS_TOKEN;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-publication-token';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key);
    return Response.json({ operation_id: operation, status: 'pending' }, { status: 202 });
  };
  try {
    for (const args of [
      ['action', '246', 'activate', '--idempotency-key', key],
      ['action', '--idempotency-key', key, '246', 'activate'],
      ['action', '246', '--idempotency-key', key, 'activate'],
    ]) {
      assert.deepEqual(await runRemote('deployments', args), {
        operation_id: operation, status: 'pending', idempotency_key: key,
      });
    }
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = token;
  }
});
