import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../api.js';
import { exportProject } from '../project-export.js';
import { documentationTopic } from '../guidance.js';

const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const zip = Buffer.concat([Buffer.from('504b0506', 'hex'), Buffer.alloc(18)]);
// A regular single-file archive, produced by the same standard-library ZIP
// writer as the server. Its payload is synthetic, not customer source.
const sourceZip = Buffer.from('UEsDBBQAAAAAAIU5KF33n1y1EgAAABIAAAAKAAAAaW5kZXguaHRtbDxoMT5CbGlua0hvc3Q8L2gxPlBLAQIUAxQAAAAAAIU5KF33n1y1EgAAABIAAAAKAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEAOAAAADoAAAAAAA==', 'base64');
const profile = { apiOrigin: 'https://api.blinkhost.me' };
const client = () => ApiClient.fromAccessToken('test', profile, 'synthetic-test-token');
const response = () => new Response(zip, { headers: { 'content-type': 'application/zip' } });

test('archive download uses the scoped canonical endpoint without redirects or retries', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), `https://api.blinkhost.me/api/source-control/connections/project-export/?project=${project}`);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-test-token');
    return response();
  };
  try {
    assert.deepEqual(await client().projectArchive(project), zip);
    await assert.rejects(client().projectArchive('../other'));
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new Error('synthetic transport loss'); };
    await assert.rejects(client().projectArchive(project), { code: 'network_error' });
    assert.equal(calls, 2);
    globalThis.fetch = async () => new Response(sourceZip, { headers: { 'content-type': 'application/zip', 'content-length': String(sourceZip.length) } });
    assert.deepEqual(await client().projectArchive(project), sourceZip);
  } finally { globalThis.fetch = original; }
});

test('archive download refuses errors, partial responses, invalid types, sizes and truncated source', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 409, 429, 500]) {
      globalThis.fetch = async () => new Response('private-response-body', { status });
      await assert.rejects(client().projectArchive(project), (error: any) => error.code === `api_${status}` && !error.message.includes('private-response-body'));
    }
    for (const value of [new Response(zip, { status: 206, headers: { 'content-type': 'application/zip' } }),
      new Response(zip, { headers: { 'content-type': 'text/html' } }),
      new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(33 * 1024 * 1024) } }),
      new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': '-1' } }),
      new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(zip.length + 1) } }),
      new Response('not a zip archive with enough bytes', { headers: { 'content-type': 'application/zip' } }),
      new Response(Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(32)]), { headers: { 'content-type': 'application/zip' } }),
      new Response(zip.subarray(0, 5), { headers: { 'content-type': 'application/zip' } })]) {
      globalThis.fetch = async () => value;
      await assert.rejects(client().projectArchive(project), { code: 'invalid_project_archive' });
    }
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/zip' } });
    await assert.rejects(client().projectArchive(project), { code: 'archive_too_large' });
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test('project export saves a private complete ZIP and never overwrites customer files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'blinkhost-export-test-'));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-test-token';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  const target = join(root, 'source.zip');
  try {
    const result = await exportProject([project, '--output', target]);
    assert.deepEqual(await readFile(target), zip);
    assert.equal(result.sha256, createHash('sha256').update(zip).digest('hex'));
    assert.equal(result.extracted, false);
    if (process.platform !== 'win32') assert.equal((await lstat(target)).mode & 0o777, 0o600);
    await assert.rejects(exportProject([project, '--output', target]), { code: 'target_exists' });
    assert.equal(calls, 1);
    for (const args of [[project], [project, '--output', join(root, 'source.txt')],
      [project, '--output', target, '--force'], ['../bad', '--output', target]]) {
      await assert.rejects(exportProject(args));
    }
    assert.equal(calls, 1);
    const raced = join(root, 'raced.zip');
    globalThis.fetch = async () => { await writeFile(raced, 'keep this'); return response(); };
    await assert.rejects(exportProject([project, '--output', raced]), { code: 'target_exists' });
    assert.equal(await readFile(raced, 'utf8'), 'keep this');
    assert.deepEqual((await readdir(root)).sort(), ['raced.zip', 'source.zip']);
    assert.ok(documentationTopic('projects')?.usage.some(line => line.includes('projects export')));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('project export rejects symlinks and leaves no file on failed downloads', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'blinkhost-export-safety-'));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
  process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-test-token';
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  try {
    if (process.platform !== 'win32') {
      await symlink(root, join(root, 'alias'));
      await assert.rejects(exportProject([project, '--output', join(root, 'alias', 'source.zip')]), { code: 'unsafe_export_directory' });
      await symlink(join(root, 'absent'), join(root, 'dangling.zip'));
      await assert.rejects(exportProject([project, '--output', join(root, 'dangling.zip')]), { code: 'target_exists' });
      assert.equal(calls, 0);
    }
    await assert.rejects(exportProject([project, '--output', join(root, 'failed.zip')]), { code: 'network_error' });
    await assert.rejects(lstat(join(root, 'failed.zip')), { code: 'ENOENT' });
    assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  }
});
