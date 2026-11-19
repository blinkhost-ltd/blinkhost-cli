import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './errors.js';
import { buildLocalSource, fingerprintLocalSource, localSourceFingerprint, type LocalSourceBuildReceipt } from './local-source-build.js';

export interface LocalSourceRebuildEvent {
  schema: 'blinkhost.local-source-rebuild/v1';
  status: 'reloaded' | 'unchanged' | 'rejected';
  attempt: number;
  error?: string;
  build?: LocalSourceBuildReceipt;
  reload?: unknown;
  previous_runtime_retained: boolean;
  watching_stopped?: boolean;
  production_authority: false;
}
export interface LocalSourcePublication {
  status: 'reloaded' | 'unchanged' | 'rejected';
  error?: string;
  [key: string]: unknown;
}
const errorCode = (error: unknown) => error instanceof CliError ? error.code
  : error instanceof Error && /^[a-z_]{1,96}$/.test(error.message) ? error.message : 'local_source_rebuild_failed';

/** Serial, bounded rebuilds. No overlapping compilers or inferred source/configuration discovery. */
export async function watchLocalSource(root: string, filename: string, directory: string, initial: LocalSourceBuildReceipt,
  publish: (build: LocalSourceBuildReceipt, verifyCandidate: () => Promise<void>) => Promise<LocalSourcePublication>,
  runtimeAvailable: () => boolean, onEvent: (event: LocalSourceRebuildEvent) => Promise<void>,
  { signal, pollMs = 1000, maxBuilds = 32, maxEvents = 64 }:
  { signal: AbortSignal; pollMs?: number; maxBuilds?: number; maxEvents?: number }): Promise<void> {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5000
    || !Number.isSafeInteger(maxBuilds) || maxBuilds < 1 || maxBuilds > 32
    || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 64) throw new Error('invalid_local_source_watch_limits');
  let seen = localSourceFingerprint(initial.source_sha256), attempt = 0, events = 0;
  const emit = async (event: LocalSourceRebuildEvent) => {
    if (signal.aborted) return;
    await writeFile(join(directory, `source-rebuild-${String(++events).padStart(3, '0')}.json`),
      JSON.stringify(event, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!signal.aborted) await onEvent(event);
  };
  while (!signal.aborted) {
    try { await delay(pollMs, undefined, { signal }); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted) return;
    let fingerprint: string;
    try { fingerprint = await fingerprintLocalSource(root, filename, initial, signal); }
    catch (error) {
      if (signal.aborted) return;
      const code = errorCode(error);
      if (seen === 'error:' + code) continue;
      seen = 'error:' + code;
      const exhausted = events >= maxEvents;
      await emit({ schema: 'blinkhost.local-source-rebuild/v1', status: 'rejected', attempt,
        error: exhausted ? 'local_source_watch_event_limit' : code, previous_runtime_retained: runtimeAvailable(),
        ...(exhausted ? { watching_stopped: true } : {}), production_authority: false });
      if (exhausted) return;
      continue;
    }
    if (fingerprint === seen) continue;
    seen = fingerprint;
    if (attempt >= maxBuilds || events >= maxEvents) {
      await emit({ schema: 'blinkhost.local-source-rebuild/v1', status: 'rejected', attempt,
        error: attempt >= maxBuilds ? 'local_source_watch_build_limit' : 'local_source_watch_event_limit',
        previous_runtime_retained: runtimeAvailable(), watching_stopped: true, production_authority: false });
      return;
    }
    let build: LocalSourceBuildReceipt | undefined, event: LocalSourceRebuildEvent;
    try {
      build = await buildLocalSource(root, filename, join(directory, `build-${String(++attempt + 1).padStart(3, '0')}`), { signal });
      if (signal.aborted) return;
      const expected = localSourceFingerprint(build.source_sha256);
      const verifyCandidate = async () => {
        if (signal.aborted) throw new Error('local_source_build_cancelled');
        if (await fingerprintLocalSource(root, filename, initial, signal) !== expected) throw new Error('local_source_build_source_changed');
      };
      await verifyCandidate();
      const reload = await publish(build, verifyCandidate);
      event = { schema: 'blinkhost.local-source-rebuild/v1', status: reload.status, attempt, build, reload,
        ...(reload.error ? { error: reload.error } : {}), previous_runtime_retained: reload.status !== 'reloaded' && runtimeAvailable(), production_authority: false };
    } catch (error) {
      if (signal.aborted) return;
      event = { schema: 'blinkhost.local-source-rebuild/v1', status: 'rejected', attempt, error: errorCode(error),
        ...(build ? { build } : {}), previous_runtime_retained: runtimeAvailable(), production_authority: false };
    }
    await emit(event);
  }
}
