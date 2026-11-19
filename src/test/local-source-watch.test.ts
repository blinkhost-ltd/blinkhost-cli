import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { buildLocalSource, fingerprintLocalSource, localSourceFingerprint, type LocalSourceBuildReceipt } from '../local-source-build.js';
import { watchLocalSource, type LocalSourcePublication, type LocalSourceRebuildEvent } from '../local-source-watch.js';

const executableDigest = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const compiler = `import fs from 'node:fs';
const input=fs.readFileSync('input.txt','utf8');
if(input==='fail')process.exit(7);
if(input==='stall') {
 fs.writeFileSync(process.env.BLINKHOST_LOCAL_BUILD_OUTPUT+'/started',String(process.pid));
 setInterval(()=>{},1000);
 await new Promise(()=>{});
}
fs.writeFileSync(process.env.BLINKHOST_LOCAL_BUILD_ARTIFACT,Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from(input)]));
`;

async function waitFor(condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10000;
  while (!await condition()) { assert.ok(Date.now() < deadline, 'bounded observation expired'); await delay(10); }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-source-watch-'));
  const controller = new AbortController(); let pending: Promise<void> | undefined;
  t.after(async () => { controller.abort(); await pending; await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src')); await mkdir(join(root, 'state'), { mode: 0o700 });
  await writeFile(join(root, 'src/input.txt'), 'initial'); await writeFile(join(root, 'src/compile.mjs'), compiler);
  const config = { schema: 'blinkhost.local-source-build/v1', source_root: 'src', files: ['compile.mjs', 'input.txt'],
    command: { path: process.execPath, sha256: executableDigest }, args: ['compile.mjs'], artifact: 'module.wasm', timeout_ms: 5000 };
  await writeFile(join(root, 'build.json'), JSON.stringify(config));
  const initial = await buildLocalSource(root, 'build.json', join(root, 'state/build-001'));
  const events: LocalSourceRebuildEvent[] = [], publications: LocalSourceBuildReceipt[] = [];
  const publish = async (build: LocalSourceBuildReceipt, verify: () => Promise<void>): Promise<LocalSourcePublication> => {
    await verify(); publications.push(build); return { status: 'reloaded' };
  };
  return { root, controller, initial, events, publications, config,
    change: async (value: string) => {
      const saved = join(root, 'src/input.next');
      await writeFile(saved, value);
      await rename(saved, join(root, 'src/input.txt'));
    },
    start: (callback = publish, limits: { maxBuilds?: number; maxEvents?: number } = {}) => {
      pending = watchLocalSource(root, 'build.json', join(root, 'state'), initial, callback, () => true,
        async event => { events.push(event); }, { signal: controller.signal, pollMs: 10, ...limits });
      return pending;
    }, stop: async () => { controller.abort(); await pending; } };
}

test('source watcher builds only changed explicit inputs and retains private serial receipts', async t => {
  const f = await fixture(t); f.start(); await delay(50);
  assert.equal(f.events.length, 0); await assert.rejects(access(join(f.root, 'state/build-002')));
  await f.change('replacement'); await waitFor(() => f.events.length === 1); await f.stop();
  const event = f.events[0]!; assert.equal(event.status, 'reloaded', event.error); assert.equal(event.attempt, 1);
  assert.equal(event.previous_runtime_retained, false); assert.equal(event.production_authority, false);
  assert.equal(f.publications.length, 1); assert.notEqual(event.build!.artifact!.sha256, f.initial.artifact!.sha256);
  assert.equal(await readFile(join(f.root, 'state/build-002/source/input.txt'), 'utf8'), 'replacement');
  const record = join(f.root, 'state/source-rebuild-001.json'); assert.equal((await lstat(record)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), event);
});

test('failed compilation retains the previous runtime and retries only after an input change', async t => {
  const f = await fixture(t); f.start(); await f.change('fail'); await waitFor(() => f.events.length === 1);
  assert.equal(f.events[0]!.error, 'local_source_build_failed'); assert.equal(f.events[0]!.previous_runtime_retained, true);
  assert.equal(f.publications.length, 0); await delay(50); assert.equal(f.events.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.root, 'state/build-002/build-result.json'), 'utf8')).status, 'rejected');
  await f.change('repaired'); await waitFor(() => f.events.length === 2); await f.stop();
  assert.equal(f.events[1]!.status, 'reloaded', f.events[1]!.error); assert.equal(f.events[1]!.attempt, 2); assert.equal(f.publications.length, 1);
});

test('candidate guard rejects source edits during publication', async t => {
  const f = await fixture(t);
  f.start(async (_build, verify) => { await verify(); await f.change('edited-during-publication'); await verify(); return { status: 'reloaded' }; });
  await f.change('candidate'); await waitFor(() => f.events.length >= 1); await f.stop();
  assert.equal(f.events[0]!.status, 'rejected'); assert.equal(f.events[0]!.error, 'local_source_build_source_changed');
  assert.equal(f.events[0]!.previous_runtime_retained, true);
});

test('configuration changes are rejected without following a new source list or compiler', async t => {
  const f = await fixture(t); f.start(); await writeFile(join(f.root, 'build.json'), JSON.stringify({ ...f.config, files: ['other.txt'] }));
  await waitFor(() => f.events.length === 1); await delay(50); await f.stop();
  assert.equal(f.events[0]!.error, 'local_source_build_configuration_changed'); assert.equal(f.publications.length, 0);
  await assert.rejects(access(join(f.root, 'state/build-002')));
});

test('source symlinks cannot redirect the watcher to another file', async t => {
  const f = await fixture(t); f.start(); await rm(join(f.root, 'src/input.txt'));
  await symlink('compile.mjs', join(f.root, 'src/input.txt')); await waitFor(() => f.events.length >= 1); await f.stop();
  assert.equal(f.events.at(-1)!.status, 'rejected'); assert.equal(f.publications.length, 0);
  await assert.rejects(access(join(f.root, 'state/build-002')));
});

test('bounded rebuild attempts explicitly stop watching while retaining the running module', async t => {
  const f = await fixture(t); const pending = f.start(undefined, { maxBuilds: 1 });
  await f.change('first'); await waitFor(() => f.events.length === 1); await f.change('second'); await pending;
  assert.equal(f.events.length, 2); assert.equal(f.events[1]!.error, 'local_source_watch_build_limit');
  assert.equal(f.events[1]!.watching_stopped, true); assert.equal(f.events[1]!.previous_runtime_retained, true);
  assert.equal(f.publications.length, 1); await assert.rejects(access(join(f.root, 'state/build-003')));
});

test('runtime admission rejection is reported without claiming publication', async t => {
  const f = await fixture(t); f.start(async () => ({ status: 'rejected', error: 'local_stack_child_start_failed' }));
  await f.change('not-admitted'); await waitFor(() => f.events.length === 1); await f.stop();
  assert.equal(f.events[0]!.error, 'local_stack_child_start_failed'); assert.equal(f.events[0]!.status, 'rejected');
  assert.equal(f.events[0]!.previous_runtime_retained, true); assert.equal(f.events[0]!.build!.status, 'compiled');
});

test('content fingerprints distinguish edits and remain stable across identical writes', async t => {
  const f = await fixture(t), expected = localSourceFingerprint(f.initial.source_sha256);
  assert.equal(await fingerprintLocalSource(f.root, 'build.json', f.initial), expected);
  await f.change('initial'); assert.equal(await fingerprintLocalSource(f.root, 'build.json', f.initial), expected);
  await f.change('changed'); assert.notEqual(await fingerprintLocalSource(f.root, 'build.json', f.initial), expected);
});

test('shutdown cancels and awaits the active compiler without publishing or emitting a failed rebuild', async t => {
  const f = await fixture(t); f.start(); await f.change('stall');
  const started = join(f.root, 'state/build-002/output/started');
  await waitFor(async () => { try { await access(started); return true; } catch { return false; } });
  const pid = Number(await readFile(started, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  process.kill(pid, 0); await f.stop();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const result = JSON.parse(await readFile(join(f.root, 'state/build-002/build-result.json'), 'utf8'));
  assert.equal(result.status, 'rejected'); assert.equal(result.error, 'local_source_build_cancelled');
  assert.equal(f.events.length, 0); assert.equal(f.publications.length, 0);
});

test('the event ceiling bounds distinct source errors and emits a final watching-stopped record', async t => {
  const f = await fixture(t); const pending = f.start(undefined, { maxEvents: 1 });
  await writeFile(join(f.root, 'build.json'), JSON.stringify({ ...f.config, files: ['other.txt'] }));
  await waitFor(() => f.events.length === 1);
  assert.equal(f.events[0]!.error, 'local_source_build_configuration_changed');
  await writeFile(join(f.root, 'build.json'), JSON.stringify(f.config));
  await f.change('next-change'); await pending;
  assert.equal(f.events.length, 2); assert.equal(f.events[1]!.error, 'local_source_watch_event_limit');
  assert.equal(f.events[1]!.watching_stopped, true); assert.equal(f.publications.length, 0);
  await assert.rejects(access(join(f.root, 'state/build-002')));
});
