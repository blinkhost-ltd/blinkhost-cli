/** Owned Linux customer-local libSQL/WasmEdge/frontend lifecycle. No cloud authority. */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createLocalFrontendServer } from './frontend-proxy.mjs';
import { providerFixtures, startProviderFixture } from './provider-fixtures.mjs';
import { providerPermissions, localProviderGrant } from './provider-grants.mjs';
import { nativeDatabasePermissions, newNativeDatabase } from './native-database.mjs';
import { RESOURCE_PROFILE_CONTRACT_SHA256 } from '../javascript-runtime/resource-profiles.js';

const CONFIG_BYTES = 65_536, LOG_BYTES = 1_048_576, RESPONSE_BYTES = 1_048_576;
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('invalid_local_stack_configuration');
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_local_stack_limit'); return value; }
function localPath(value, root) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) fail('invalid_local_stack_path');
  return path.resolve(root, value);
}
function pinnedFile(value, root) {
  keys(value, ['path', 'sha256']);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('invalid_local_stack_digest');
  return { path: localPath(value.path, root), sha256: value.sha256 };
}

export function configuration(value, root) {
  keys(value, ['schema', 'runtime', 'engine', 'database', 'artifact', 'frontend'], ['limits', 'providers', 'provider_permissions']);
  if (value.schema !== 'blinkhost.local-stack/v1') fail('unsupported_local_stack_schema');
  keys(value.database, ['executable', 'setup'], ['native']);
  if (!Array.isArray(value.database.setup) || value.database.setup.length > 128) fail('invalid_local_stack_setup');
  const setup = value.database.setup.map(statement => {
    keys(statement, ['sql'], ['args']);
    if (typeof statement.sql !== 'string' || !statement.sql.trim() || Buffer.byteLength(statement.sql) > 16_384
      || statement.sql.includes('\0')) fail('invalid_local_stack_sql');
    const args = statement.args ?? [];
    if (!Array.isArray(args) || args.length > 128) fail('invalid_local_stack_sql_arguments');
    for (const arg of args) {
      keys(arg, ['type'], arg.type === 'null' ? [] : ['value', 'base64']);
      switch (arg.type) {
        case 'null': break;
        case 'text':
          if (Object.keys(arg).length !== 2 || typeof arg.value !== 'string' || Buffer.byteLength(arg.value) > 16_384) fail('invalid_local_stack_sql_arguments');
          break;
        case 'integer':
          if (Object.keys(arg).length !== 2 || typeof arg.value !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(arg.value)
            || BigInt(arg.value) < -(1n << 63n) || BigInt(arg.value) >= (1n << 63n)) fail('invalid_local_stack_sql_arguments');
          break;
        case 'float':
          if (Object.keys(arg).length !== 2 || typeof arg.value !== 'number' || !Number.isFinite(arg.value)) fail('invalid_local_stack_sql_arguments');
          break;
        case 'blob':
          if (Object.keys(arg).length !== 2 || typeof arg.base64 !== 'string' || arg.base64.length > 21_848
            || Buffer.from(arg.base64, 'base64').toString('base64') !== arg.base64) fail('invalid_local_stack_sql_arguments');
          break;
        default: fail('invalid_local_stack_sql_arguments');
      }
    }
    return { sql: statement.sql, args };
  });
  const limits = value.limits ?? {};
  keys(limits, [], ['max_concurrent', 'request_timeout_ms']);
  const providers = providerFixtures(value.providers);
  const providerGrant = providerPermissions(value.provider_permissions, providers);
  return { runtime: pinnedFile(value.runtime, root), engine: pinnedFile(value.engine, root),
    database: pinnedFile(value.database.executable, root), artifact: pinnedFile(value.artifact, root),
    frontend: localPath(value.frontend, root), setup, native: nativeDatabasePermissions(value.database.native), providers, providerGrant,
    concurrent: integer(limits.max_concurrent ?? 4, 1, 10),
    requestTimeout: integer(limits.request_timeout_ms ?? 30_000, 1, 30_000) };
}

async function boundedRead(filename, maximum) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum) fail('local_stack_file_limit');
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length !== metadata.size) fail('local_stack_file_changed');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function readConfiguration(filename) {
  const absolute = await realpath(filename);
  const bytes = await boundedRead(absolute, CONFIG_BYTES);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_local_stack_json'); }
  return { ...configuration(parsed, path.dirname(absolute)), configSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function configurationDigest(filename) {
  return createHash('sha256').update(await boundedRead(filename, CONFIG_BYTES)).digest('hex');
}

function runtimeIdentity(health, config, native, providerGrant) {
  if (health.schema !== 'blinkhost.local-runtime/v1' || health.engine !== '0.18.1'
    || health.artifact_sha256 !== config.artifact.sha256 || health.guest_memory_bytes !== 134_217_728
    || health.resource_contract_sha256 !== RESOURCE_PROFILE_CONTRACT_SHA256 || !health.database_read
    || health.native_database !== Boolean(native) || health.max_concurrent !== config.concurrent
    || health.request_timeout_ms !== config.requestTimeout) fail('local_stack_runtime_identity_mismatch');
  if (native && (!health.native_database_scope || Object.keys(health.native_database_scope).length !== 4
    || Object.keys(native.scope).some(key => health.native_database_scope[key] !== native.scope[key])
    || !health.native_database_permissions || Object.keys(health.native_database_permissions).length !== 3
    || ['read', 'write', 'transaction'].some(key => health.native_database_permissions[key] !== config.native[key]))) {
    fail('local_stack_runtime_native_identity_mismatch');
  }
  if (Boolean(health.provider_permissions) !== Boolean(providerGrant)
    || !isDeepStrictEqual(health.provider_grant ?? null, providerGrant)) fail('local_stack_runtime_provider_identity_mismatch');
}

function runtimeArguments(config, databaseOrigin, native, providerGrant) {
  const args = ['--artifact', config.artifact.path, '--database-url', databaseOrigin,
    '--listen', '127.0.0.1:0', '--max-concurrent', String(config.concurrent),
    '--request-timeout-ms', String(config.requestTimeout)];
  if (native) args.push('--native-database', JSON.stringify(native.grant));
  if (providerGrant) args.push('--local-providers', JSON.stringify(providerGrant));
  return args;
}

async function verifyFile(item, maximum) {
  item.path = await realpath(item.path);
  const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum) fail('local_stack_file_limit');
    const hash = createHash('sha256'); let size = 0;
    for await (const bytes of file.createReadStream({ autoClose: false })) {
      size += bytes.length;
      if (size > maximum) fail('local_stack_file_limit');
      hash.update(bytes);
    }
    if (size !== metadata.size || hash.digest('hex') !== item.sha256) fail('local_stack_digest_mismatch');
  } finally { await file.close(); }
}

// Discover the ephemeral listener from sockets owned by this exact child. No
// reserve/close/rebind race, no chosen public listener and no existing DB origin.
export async function ownedListenerOrigin(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('invalid_local_stack_pid');
  const directory = `/proc/${pid}/fd`;
  const sockets = new Set();
  for (const fd of await readdir(directory)) {
    try {
      const target = await readlink(`${directory}/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) sockets.add(match[1]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const listeners = new Set();
  for (const line of (await readFile(`/proc/${pid}/net/tcp`, 'utf8')).trim().split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns[3] !== '0A' || !sockets.has(columns[9])) continue;
    const [address, port] = columns[1].split(':');
    if (address !== '0100007F') fail('local_stack_child_listener_changed');
    listeners.add(`http://127.0.0.1:${Number.parseInt(port, 16)}`);
  }
  if (listeners.size > 1) fail('local_stack_child_listener_ambiguous');
  return [...listeners][0];
}

function launch(name, executable, args, directory, env) {
  const descriptor = openSync(path.join(directory, `${name}.log`), 'wx', 0o600);
  const child = spawn(executable, args, { cwd: directory, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let notifyFailure;
  const owner = { name, child, exited: false, spawnError: false, code: null, signal: null,
    loggedBytes: 0, droppedLogBytes: 0, logFailed: false, failure: new Promise(resolve => { notifyFailure = resolve; }) };
  const log = bytes => {
    const remaining = LOG_BYTES - owner.loggedBytes;
    if (remaining > 0) {
      const part = bytes.subarray(0, remaining);
      try { writeSync(descriptor, part); owner.loggedBytes += part.length; }
      catch { owner.logFailed = true; notifyFailure(); }
    }
    owner.droppedLogBytes += Math.max(0, bytes.length - Math.max(0, remaining));
  };
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.once('error', () => { owner.spawnError = true; });
  owner.done = new Promise(resolve => child.once('close', (code, signal) => {
    owner.exited = true; owner.code = code; owner.signal = signal;
    try { closeSync(descriptor); } catch { owner.logFailed = true; }
    notifyFailure(); resolve(owner);
  }));
  return owner;
}

const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(new Error('local_stack_interrupted')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', abort, { once: true });
});
async function stopChild(owner) {
  if (!owner.exited) owner.child.kill('SIGTERM');
  const wait = async milliseconds => {
    let timer;
    try { await Promise.race([owner.done, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  await wait(6000);
  if (!owner.exited) {
    owner.child.kill('SIGKILL');
    await wait(3000);
  }
  if (!owner.exited) fail('local_stack_child_stop_failed');
}

async function jsonRequest(url, body, signal) {
  const abort = AbortSignal.timeout(2000);
  const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([abort, signal]) : abort });
  if (response.status !== 200) { await response.body?.cancel(); fail('local_stack_http_failure'); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > RESPONSE_BYTES) { await response.body.cancel().catch(() => {}); fail('local_stack_response_limit'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function sqlExecute(origin, statement, signal) {
  // Only the orchestrator's discovered local child origin is used by setup.
  const port = typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
  if (!port || Number(port[1]) > 65535) fail('invalid_local_stack_origin');
  const payload = await jsonRequest(origin + '/v2/pipeline', { requests: [
    { type: 'execute', stmt: { ...statement, want_rows: true } }, { type: 'close' } ] }, signal);
  if (!Array.isArray(payload.results) || payload.results.length !== 2
    || payload.results.some(row => row.type !== 'ok') || payload.results[0].response?.type !== 'execute') fail('local_stack_sql_failure');
  return payload.results[0].response.result;
}

async function ready(owner, suffix, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (owner.exited || owner.spawnError || owner.logFailed) fail('local_stack_child_start_failed');
    let origin;
    try { origin = await ownedListenerOrigin(owner.child.pid); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    if (origin) {
      try {
        const health = suffix ? await jsonRequest(origin + suffix, undefined, signal)
          : await sqlExecute(origin, { sql: 'SELECT 1', args: [] }, signal);
        if (!owner.exited) return { origin, health };
      } catch { signal?.throwIfAborted(); }
    }
    await pause(25, signal);
  }
  fail('local_stack_readiness_timeout');
}

export async function startLocalStack(filename, requestedDirectory, { signal } = {}) {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) fail('unsupported_local_stack_platform');
  signal?.throwIfAborted();
  const config = await readConfiguration(filename);
  if (path.basename(config.engine.path) !== 'libwasmedge.so') fail('invalid_local_stack_engine_path');
  const engineDirectory = await realpath(path.dirname(config.engine.path));
  await verifyFile(config.runtime, 512 * 1024 * 1024);
  await verifyFile(config.engine, 512 * 1024 * 1024);
  await verifyFile(config.database, 512 * 1024 * 1024);
  await verifyFile(config.artifact, 20_000_000);
  const version = await promisify(execFile)(config.database.path, ['--version'], {
    env: { PATH: path.dirname(process.execPath), LANG: 'C.UTF-8' },
    timeout: 2000, maxBuffer: 4096, signal });
  if (!/^sqld sqld 0\.24\.32 \(/.test(version.stdout.trim())) fail('local_stack_database_version_mismatch');
  config.frontend = await realpath(config.frontend);
  if (!(await stat(config.frontend)).isDirectory()) fail('invalid_local_stack_frontend');
  const requested = path.resolve(requestedDirectory);
  const directory = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  if (directory === config.frontend || directory.startsWith(config.frontend + path.sep)) fail('local_stack_private_state_in_frontend');
  signal?.throwIfAborted();
  // Never resume/reset an existing directory or erase a failed run's database.
  await mkdir(directory, { mode: 0o700 });
  const children = [], providers = [], lifecycle = new AbortController();
  let frontend, stopping, resolveClosed, reloading, reloadAttempts = 0, phase = 'initializing';
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const env = { PATH: path.dirname(process.execPath), LANG: 'C.UTF-8',
    LD_LIBRARY_PATH: engineDirectory, TMPDIR: path.join(directory, 'tmp') };
  const stop = (reason = 'stopped') => {
    if (stopping) return stopping;
    stopping = (async () => {
      signal?.removeEventListener('abort', interrupted);
      lifecycle.abort();
      if (frontend) { frontend.closeAllConnections(); await new Promise(resolve => frontend.close(resolve)); }
      if (reloading) await reloading.catch(() => {});
      let stopFailed = false;
      // VM shutdown precedes libSQL shutdown; both handles were started here.
      for (const owner of [...children].reverse()) {
        try { await stopChild(owner); } catch { stopFailed = true; }
      }
      const providerEvidence = {};
      for (const provider of providers) {
        try { providerEvidence[provider.name] = await provider.fixture.stop(); } catch { stopFailed = true; }
      }
      if (providers.length) {
        try { await writeFile(path.join(directory, 'provider-fixtures.json'), JSON.stringify(providerEvidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch { stopFailed = true; }
      }
      const result = { schema: 'blinkhost.local-stack-stop/v1', status: stopFailed ? 'failed' : reason,
        phase, children_stopped: children.every(owner => owner.exited),
        provider_fixtures_stopped: Object.keys(providerEvidence).length === providers.length
          && Object.values(providerEvidence).every(provider => provider.active === 0),
        children: children.map(owner => ({ name: owner.name, pid: owner.child.pid ?? null,
          exit_code: owner.code, signal: owner.signal, log_bytes: owner.loggedBytes,
          dropped_log_bytes: owner.droppedLogBytes, log_error: owner.logFailed })),
        data_preserved: true, production_authority: false };
      try { await writeFile(path.join(directory, 'stopped.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { result.status = 'failed'; result.stop_evidence_written = false; }
      resolveClosed(result); return result;
    })();
    return stopping;
  };
  const interrupted = () => { stop('interrupted').catch(() => {}); };
  try {
    await mkdir(env.TMPDIR, { mode: 0o700 });
    signal?.throwIfAborted();
    phase = 'database';
    const database = launch('database', config.database.path, ['--no-welcome', '--disable-metrics',
      '--http-listen-addr', '127.0.0.1:0', '--db-path', path.join(directory, 'project.sqld')], directory, env);
    children.push(database);
    const { origin: databaseOrigin } = await ready(database, undefined, signal);
    phase = 'setup';
    for (const statement of config.setup) await sqlExecute(databaseOrigin, statement, signal);
    // Only this freshly created child database receives privileged receipt state.
    const native = newNativeDatabase(config.native ?? undefined);
    if (native) {
      phase = 'native-database-setup';
      for (const statement of native.setup) await sqlExecute(databaseOrigin, statement, signal);
    }
    phase = 'providers';
    for (const [name, definition] of Object.entries(config.providers)) {
      signal?.throwIfAborted();
      providers.push({ name, fixture: await startProviderFixture(name, definition) });
    }
    phase = 'runtime';
    const providerGrant = localProviderGrant(config.providerGrant, config.artifact.sha256, config.providers, providers);
    let runtime = launch('runtime', config.runtime.path, runtimeArguments(config, databaseOrigin, native, providerGrant), directory, env);
    children.push(runtime);
    const { origin: runtimeOrigin, health } = await ready(runtime, '/__blinkhost/health', signal);
    runtimeIdentity(health, config, native, providerGrant);
    phase = 'frontend';
    frontend = await createLocalFrontendServer({ frontend: config.frontend, runtime: runtimeOrigin });
    await new Promise((resolve, reject) => {
      frontend.once('error', reject); frontend.listen(0, '127.0.0.1', resolve);
    });
    signal?.throwIfAborted();
    if (children.some(owner => owner.exited)) fail('local_stack_child_start_failed');
    phase = 'ready';
    let manifest = { schema: 'blinkhost.local-stack/v1', ready: true,
      frontend: `http://127.0.0.1:${frontend.address().port}`, runtime: runtimeOrigin, database: databaseOrigin,
      state_directory: directory, config_sha256: config.configSha256,
      inputs: Object.fromEntries(['runtime', 'engine', 'database', 'artifact'].map(key => [key, config[key].sha256])),
      engine: health.engine, libsql: '0.24.32', guest_memory_bytes: health.guest_memory_bytes, max_concurrent: config.concurrent,
      request_timeout_ms: config.requestTimeout, setup_statements: config.setup.length,
      children: children.map(owner => ({ name: owner.name, pid: owner.child.pid })),
      provider_fixtures: Object.fromEntries(providers.map(provider => [provider.name, provider.fixture.origin])),
      database_read: true, native_database: Boolean(native), native_database_scope: native?.scope ?? null,
      native_database_permissions: config.native, provider_permissions: Boolean(providerGrant),
      provider_grant: providerGrant, reload_generation: 0, production_authority: false };
    await writeFile(path.join(directory, 'ready.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const supervise = owner => owner.failure.then(() => {
      if (!stopping && owner.published && !owner.intentionalExit) stop('failed').catch(() => {});
    });
    for (const owner of children) { owner.published = true; supervise(owner); }

    const reload = ({ verifyCandidate } = {}) => {
      if (verifyCandidate !== undefined && typeof verifyCandidate !== 'function') return Promise.reject(new Error('invalid_local_stack_reload_guard'));
      if (stopping) return Promise.reject(new Error('local_stack_stopped'));
      if (reloading) return Promise.reject(new Error('local_stack_reload_busy'));
      reloading = (async () => {
        const next = await readConfiguration(filename);
        if (next.configSha256 === manifest.config_sha256) {
          await verifyCandidate?.();
          return { status: 'unchanged', manifest };
        }
        // Changed permissions, tools, frontend, limits or setup need a fresh
        // stack. Reload is exclusively an artifact replacement, never a seed
        // replay, scope reset or permission escalation.
        for (const name of ['runtime', 'engine', 'database']) next[name].path = await realpath(next[name].path);
        next.frontend = await realpath(next.frontend);
        const stable = value => ({ ...value, artifact: undefined, configSha256: undefined });
        if (!isDeepStrictEqual(stable(next), stable(config))) fail('local_stack_reload_configuration_changed');
        for (const name of ['runtime', 'engine', 'database']) await verifyFile(next[name], 512 * 1024 * 1024);
        await verifyFile(next.artifact, 20_000_000);
        if (next.artifact.sha256 === manifest.inputs.artifact) {
          await verifyCandidate?.();
          manifest = { ...manifest, config_sha256: next.configSha256 };
          return { status: 'unchanged', manifest };
        }
        if (reloadAttempts >= 32) fail('local_stack_reload_limit');
        const bytes = await boundedRead(next.artifact.path, 20_000_000);
        if (createHash('sha256').update(bytes).digest('hex') !== next.artifact.sha256) fail('local_stack_digest_mismatch');
        await verifyCandidate?.();
        lifecycle.signal.throwIfAborted();
        const attempt = ++reloadAttempts, stem = `reload-${String(attempt).padStart(3, '0')}`;
        next.artifact.path = path.join(directory, stem + '.wasm');
        await writeFile(next.artifact.path, bytes, { flag: 'wx', mode: 0o600 });
        let candidate, paused = false, retirementStarted = false, result;
        const began = performance.now();
        try {
          const grant = localProviderGrant(next.providerGrant, next.artifact.sha256, next.providers, providers);
          candidate = launch(stem, config.runtime.path, runtimeArguments(next, databaseOrigin, native, grant), directory, env);
          children.push(candidate); supervise(candidate);
          const replacement = await ready(candidate, '/__blinkhost/health', lifecycle.signal);
          runtimeIdentity(replacement.health, next, native, grant);
          if (replacement.health.available_slots !== config.concurrent || replacement.health.active_executions !== 0) {
            fail('local_stack_reload_candidate_busy');
          }
          if (await configurationDigest(filename) !== next.configSha256) fail('local_stack_reload_configuration_raced');
          lifecycle.signal.throwIfAborted();
          frontend.setRuntimePaused(true); paused = true;
          const deadline = performance.now() + 35_000;
          while (true) {
            lifecycle.signal.throwIfAborted();
            if (candidate.exited || runtime.exited) fail('local_stack_reload_process_failed');
            const current = await jsonRequest(manifest.runtime + '/__blinkhost/health', undefined, lifecycle.signal);
            if (current.artifact_sha256 !== manifest.inputs.artifact) fail('local_stack_reload_previous_identity_changed');
            if (frontend.activeRuntimeRequests === 0 && current.available_slots === config.concurrent
              && current.active_executions === 0) break;
            if (performance.now() >= deadline) fail('local_stack_reload_drain_timeout');
            await pause(25, lifecycle.signal);
          }
          // Verify again after draining: a build/config edit during the wait
          // cannot publish a candidate from an obsolete input snapshot.
          if (await configurationDigest(filename) !== next.configSha256) fail('local_stack_reload_configuration_raced');
          const candidateHealth = await jsonRequest(replacement.origin + '/__blinkhost/health', undefined, lifecycle.signal);
          runtimeIdentity(candidateHealth, next, native, grant);
          if (candidateHealth.available_slots !== config.concurrent || candidateHealth.active_executions !== 0) {
            fail('local_stack_reload_candidate_busy');
          }
          await verifyCandidate?.();
          lifecycle.signal.throwIfAborted();
          runtime.intentionalExit = true;
          retirementStarted = true;
          await stopChild(runtime);
          lifecycle.signal.throwIfAborted();
          if (candidate.exited) fail('local_stack_reload_process_failed');
          const updated = { ...manifest, runtime: replacement.origin, config_sha256: next.configSha256,
            inputs: { ...manifest.inputs, artifact: next.artifact.sha256 }, provider_grant: grant,
            children: [database, candidate].map(owner => ({ name: owner.name, pid: owner.child.pid })),
            reload_generation: manifest.reload_generation + 1 };
          result = { schema: 'blinkhost.local-artifact-reload/v1', status: 'reloaded',
            attempt, previous_artifact_sha256: manifest.inputs.artifact,
            artifact_sha256: next.artifact.sha256, config_sha256: next.configSha256,
            artifact_path: next.artifact.path, manifest: updated,
            duration_ms: Math.ceil(performance.now() - began), production_authority: false };
          await writeFile(path.join(directory, stem + '.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          frontend.setRuntime(replacement.origin);
          candidate.published = true; runtime = candidate; manifest = updated;
          frontend.setRuntimePaused(false); paused = false;
          return result;
        } catch (error) {
          let candidateStopFailed = false;
          if (candidate) {
            candidate.intentionalExit = true;
            try { await stopChild(candidate); } catch { candidateStopFailed = true; }
          }
          // Before retirement, any invalid replacement retains the working
          // module. A shutdown/crash after retirement must fail the whole stack.
          if ((retirementStarted || candidateStopFailed) && !stopping) queueMicrotask(() => { stop('failed').catch(() => {}); });
          const code = candidateStopFailed ? 'local_stack_child_stop_failed'
            : error instanceof Error && /^[a-z_]{1,96}$/.test(error.message) ? error.message : 'local_stack_reload_failed';
          result = { schema: 'blinkhost.local-artifact-reload/v1', status: 'rejected',
            attempt, artifact_sha256: next.artifact.sha256, config_sha256: next.configSha256,
            artifact_path: next.artifact.path, error: code,
            previous_runtime_retained: !retirementStarted && !candidateStopFailed && !stopping,
            duration_ms: Math.ceil(performance.now() - began), production_authority: false };
          await writeFile(path.join(directory, stem + '.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          return result;
        } finally { if (paused && !stopping) frontend.setRuntimePaused(false); }
      })().finally(() => { reloading = undefined; });
      return reloading;
    };
    signal?.addEventListener('abort', interrupted, { once: true });
    if (signal?.aborted) interrupted();
    return { get manifest() { return manifest; },
      get runtimeAvailable() { return !stopping && !runtime.exited; }, stop, closed, reload };
  } catch (error) {
    await stop('failed'); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--state-dir') fail('expected_local_stack_config_and_new_state_directory');
    const stack = await startLocalStack(args[1], args[3], { signal: controller.signal });
    console.log(JSON.stringify(stack.manifest));
    const result = await stack.closed;
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } catch (error) {
    console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'local_stack_start_failed'); process.exitCode = 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
