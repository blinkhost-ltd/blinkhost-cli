import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssistant } from '../assistant.js';
import { validatePeerResponse } from '../peer-review.js';
import { documentationTopic } from '../guidance.js';

const task = '597a2b2d-53cb-4396-a021-9be4de0f1af0';
const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const peer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const digest = 'a'.repeat(64);
const stamp = '2026-09-10T12:00:00Z';
const metadata = () => ({ id: peer, project_id: project, reviewer_id: 7, review_digest: digest,
  expires_at: stamp, approved_at: null, declined_at: null, revoked_at: null, verification: 'source_review_only' });
const source = () => ({ ...metadata(), diffs: [{ path: 'main.ts', diff: '+inert code [U+001B]' }] });
const options = () => ({ project_id: project, task_id: task, truncated: false, required: false,
  reviewers: [{ id: 7, name: 'Synthetic reviewer', role: 'admin' }], active: metadata() });

test('unknown assistant commands point to complete local help and peer inbox', async () => {
  await assert.rejects(runAssistant(['unknown-command']), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ai peer-inbox/);
    assert.match(error.message, /blinkhost docs ai/);
    return true;
  });
});

test('peer actions require explicit scope, reviewed digest and exact confirmation before any network call', async () => {
  for (const args of [
    ['peer-inbox'], ['peer-review', peer, '--project', '../wrong'],
    ['peer-invite', task, '--project', project, '--reviewer', '7', '--digest', digest],
    ['peer-invite', task, '--project', project, '--reviewer', '0', '--digest', digest, '--confirm', task],
    ['peer-invite', task, '--project', project, '--reviewer', '9007199254740992', '--digest', digest, '--confirm', task],
    ['peer-approve', peer, '--project', project, '--digest', digest, '--confirm', task],
    ['peer-decline', peer, '--project', project, '--confirm', peer],
    ['peer-withdraw', task, '--project', project, '--confirm', task],
    ['peer-inbox', '--project', project, '--force'],
  ]) await assert.rejects(runAssistant(args));
  for (const command of ['peer-options', 'peer-invite', 'peer-inbox', 'peer-review', 'peer-approve', 'peer-withdraw']) {
    assert.ok(documentationTopic('ai')?.usage.some(line => line.includes(command)));
  }
});

test('peer response validation rejects wrong authority, private fields, malformed source and contradictory decisions', () => {
  const expected = { project, peer, digest, reviewer: 7 };
  validatePeerResponse(source(), expected, 'peer-review');
  for (const change of [{ project_id: task }, { id: task }, { reviewer_id: 9 }, { review_digest: 'b'.repeat(64) },
    { approved_at: stamp, declined_at: stamp }, { revoked_at: false }, { expires_at: 'bad' },
    { diffs: [] }, { diffs: [null] }, { diffs: [...source().diffs, ...source().diffs] },
    { diffs: [{ path: 'main.ts', diff: 'ok', private: 'extra' }] }, { prompt: 'private' },
    { verification: 'deployed' }]) assert.throws(() => validatePeerResponse({ ...source(), ...change }, expected, 'peer-review'));
  assert.throws(() => validatePeerResponse(source(), expected, 'peer-approve'));
  assert.throws(() => validatePeerResponse({ ...source(), approved_at: stamp, revoked_at: stamp }, expected, 'peer-approve'));
  assert.throws(() => validatePeerResponse({ id: task, revoked_at: stamp }, expected, 'peer-withdraw'));
  validatePeerResponse(options(), { project, task }, 'peer-options');
  validatePeerResponse({ ...options(), required: true }, { project, task }, 'peer-options');
  for (const required of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
    assert.throws(() => validatePeerResponse({ ...options(), required }, { project, task }, 'peer-options'));
  }
  const { required: _required, ...missingPolicy } = options();
  assert.throws(() => validatePeerResponse(missingPolicy, { project, task }, 'peer-options'));
  for (const change of [{ active: source() }, { task_id: peer }, { reviewers: [...options().reviewers, ...options().reviewers] },
    { reviewers: [{ id: 7, name: 'wrong role', role: 'member' }] }]) {
    assert.throws(() => validatePeerResponse({ ...options(), ...change }, { project, task }, 'peer-options'));
  }
  assert.throws(() => validatePeerResponse({ project_id: project, truncated: false, reviews: [metadata(), metadata()] }, expected, 'peer-inbox'));
});

test('peer CLI uses one scoped API call per action without saving, building, publishing or automatic retries', async () => {
  const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
  const cases = [
    { args: ['peer-options', task], path: `tasks/${task}/peer-review/`, value: options(), body: undefined },
    { args: ['peer-inbox'], path: `projects/${project}/peer-reviews/`, value: { project_id: project, truncated: false, reviews: [metadata()] }, body: undefined },
    { args: ['peer-review', peer], path: `peer-reviews/${peer}/`, value: source(), body: undefined },
    { args: ['peer-invite', task, '--reviewer', '7', '--digest', digest, '--confirm', task], path: `tasks/${task}/peer-review/`, value: metadata(), body: { reviewer_id: 7, action_digest: digest } },
    { args: ['peer-approve', peer, '--digest', digest, '--confirm', peer], path: `peer-reviews/${peer}/approve/`, value: { ...source(), approved_at: stamp }, body: { review_digest: digest, approve: true } },
    { args: ['peer-decline', peer, '--digest', digest, '--confirm', peer], path: `peer-reviews/${peer}/approve/`, value: { ...source(), declined_at: stamp }, body: { review_digest: digest, approve: false } },
    { args: ['peer-withdraw', task, '--peer', peer, '--confirm', task], path: `tasks/${task}/peer-review/withdraw/`, value: { id: peer, revoked_at: stamp }, body: { peer_id: peer } },
  ];
  try {
    for (const item of cases) {
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls += 1;
        assert.ok(String(url).endsWith(`/api/idam/${item.path}`));
        assert.equal(init?.method, item.body ? 'POST' : undefined);
        assert.equal(init?.body, item.body ? JSON.stringify(item.body) : undefined);
        return new Response(JSON.stringify(item.value), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const result = await runAssistant([...item.args, '--project', project]);
      assert.deepEqual(result.data, item.value);
      if (item.args[0] === 'peer-withdraw') {
        assert.match(result.message, /history is retained/);
        assert.match(result.message, /review required by your workspace still applies before saving/);
        assert.doesNotMatch(result.message, /no longer blocks saving/);
      }
      assert.equal(calls, 1);
      calls = 0;
      globalThis.fetch = async () => { calls += 1; throw new Error('synthetic connection loss'); };
      await assert.rejects(runAssistant([...item.args, '--project', project]));
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
  }
});
