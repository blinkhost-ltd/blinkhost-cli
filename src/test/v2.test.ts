import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_API_ORIGIN, readConfig, validateApiOrigin, writeConfig } from '../config.js';
import { CliError } from '../errors.js';
import { rawApi, readProjectLink, runFunctions, writeProjectLink } from '../remote.js';
import { checkForUpdate, completion, releaseNotes, runPlugins, supportBundle } from '../workflows.js';

test('profile configuration is private and API origins reject unsafe forms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-config-'));
  const previous = process.env.BLINKHOST_CONFIG_HOME;
  process.env.BLINKHOST_CONFIG_HOME = root;
  try {
    assert.equal(validateApiOrigin(DEFAULT_API_ORIGIN), DEFAULT_API_ORIGIN);
    assert.throws(() => validateApiOrigin('http://api.example.com'), CliError);
    assert.throws(() => validateApiOrigin('https://user:secret@example.com'), CliError);
    await writeConfig({ activeProfile: 'work', profiles: { work: { apiOrigin: DEFAULT_API_ORIGIN } }, updateCheckedAt: '2026-09-02T00:00:00.000Z', latestVersion: '2.4.0' });
    const config = await readConfig();
    assert.equal(config.activeProfile, 'work');
    assert.equal(config.latestVersion, '2.4.0');
    assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.BLINKHOST_CONFIG_HOME;
    else process.env.BLINKHOST_CONFIG_HOME = previous;
  }
});

test('release checks and notes use the public BlinkHost registry without installing', async () => {
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (String(input).includes('/latest/')) return new Response(JSON.stringify({ current_version: '2.4.0', latest_version: '2.5.0', update_available: true, release_url: 'https://app.blinkhost.me/docs/releases/cli/2.5.0', install_command: 'npm install --global @blinkhost/cli@2.5.0' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify([{ component: 'cli', version: '2.5.0', summary: 'Example' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const update = await checkForUpdate() as { latest_version: string; automatic_install: boolean };
    assert.equal(update.latest_version, '2.5.0');
    assert.equal(update.automatic_install, false);
    const notes = await releaseNotes('2.5.0') as { version: string };
    assert.equal(notes.version, '2.5.0');
    assert.match(urls[0] || '', /api\/documentation\/releases\/latest/);
  } finally { globalThis.fetch = previousFetch; }
});

test('project links are explicit, local, and contain no credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-link-'));
  const written = await writeProjectLink('2a594fd8-cc93-47c1-864f-697765d5bd23', 'default', root);
  assert.deepEqual(await readProjectLink(root), written);
  const raw = await readFile(join(root, '.blinkhost', 'project.json'), 'utf8');
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes('secret'), false);
});

test('raw API blocks staff, internal, auth, and secret-bearing mutation paths before authentication', async () => {
  for (const [method, path] of ([['GET', '/api/internal/status/'], ['GET', '/api/ops/legal/'], ['POST', '/api/auth/login/'], ['POST', '/api/project-secrets/']] as Array<[string, string]>)) {
    await assert.rejects(rawApi([method, path]), CliError);
  }
});

test('function invocation uses the dedicated API with bounded explicit idempotency', async () => {
  const previousToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'test-workload-token';
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ id: 'run-1', state: 'queued' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await runFunctions([
      'invoke', 'run',
      '6b1f7131-f314-4f10-b8b8-8e59a414fc4c',
      'b92d7da6-137f-4e9a-8876-30d433d58548',
      '--data', '{"record":42}',
      '--idempotency-key', 'order-42',
    ]);
    assert.equal(capturedUrl, 'https://api.blinkhost.me/api/backend-modules/6b1f7131-f314-4f10-b8b8-8e59a414fc4c/triggers/b92d7da6-137f-4e9a-8876-30d433d58548/invoke/');
    assert.equal(capturedInit?.method, 'POST');
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-workload-token');
    assert.equal(headers.get('idempotency-key'), 'order-42');
    assert.equal(capturedInit?.body, '{"payload":{"record":42}}');
    await assert.rejects(
      runFunctions([
        'invocations', 'retry',
        '6b1f7131-f314-4f10-b8b8-8e59a414fc4c',
        'a837c2ea-9332-46fa-a786-bb77ac065064',
        '--idempotency-key', 'unsafe\tkey',
      ]),
      /Idempotency keys/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = previousToken;
  }
});

test('function status uses the project-scoped capability endpoint', async () => {
  const previousToken = process.env.BLINKHOST_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BLINKHOST_ACCESS_TOKEN = 'test-workload-token';
  let capturedUrl = '';
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ languages: {}, capabilities: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await runFunctions(['status', '2a594fd8-cc93-47c1-864f-697765d5bd23']);
    assert.equal(
      capturedUrl,
      'https://api.blinkhost.me/api/backend-modules/rollout-status/?site_id=2a594fd8-cc93-47c1-864f-697765d5bd23',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BLINKHOST_ACCESS_TOKEN;
    else process.env.BLINKHOST_ACCESS_TOKEN = previousToken;
  }
});

test('shell completion is deterministic', () => {
  assert.match(completion('bash'), /complete/);
  assert.match(completion('zsh'), /#compdef/);
  assert.match(completion('fish'), /complete -c blinkhost/);
  assert.match(completion('powershell'), /Register-ArgumentCompleter/);
  assert.throws(() => completion('nushell'), CliError);
});

test('plugins are digest pinned and stop after executable changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-plugin-'));
  const previous = process.env.BLINKHOST_CONFIG_HOME;
  process.env.BLINKHOST_CONFIG_HOME = join(root, 'config');
  const executable = join(root, 'example-plugin');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    await runPlugins(['add', executable, '--name', 'example']);
    const verified = await runPlugins(['verify', 'example']) as { verified: boolean };
    assert.equal(verified.verified, true);
    await writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await assert.rejects(runPlugins(['verify', 'example']), /changed after approval/);
  } finally {
    if (previous === undefined) delete process.env.BLINKHOST_CONFIG_HOME;
    else process.env.BLINKHOST_CONFIG_HOME = previous;
  }
});

test('support bundles exclude source paths and secret declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-support-'));
  const output = join(root, 'bundle.json');
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    await supportBundle(['--output', output]);
    const raw = await readFile(output, 'utf8');
    assert.equal(raw.includes('access_token'), false);
    assert.equal(raw.includes('refresh_token'), false);
    assert.equal(raw.includes(previousCwd), false);
  } finally { process.chdir(previousCwd); }
});
