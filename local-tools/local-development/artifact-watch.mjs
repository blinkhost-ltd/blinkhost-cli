/** Poll one explicit local config; builds and cloud actions are not inferred. */
import { setTimeout as delay } from 'node:timers/promises';
import { configurationDigest } from './local-stack.mjs';

export async function watchLocalArtifacts(stack, filename, onEvent, { signal } = {}) {
  let seen = stack.manifest.config_sha256;
  while (!signal?.aborted) {
    try { await delay(500, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return; throw error; }
    if (signal?.aborted) return;
    let digest, event;
    try { digest = await configurationDigest(filename); }
    catch {
      if (seen === 'unavailable') continue;
      seen = 'unavailable';
      event = { schema: 'blinkhost.local-artifact-reload/v1', status: 'rejected',
        error: 'local_stack_configuration_unavailable', previous_runtime_retained: stack.runtimeAvailable === true,
        production_authority: false };
    }
    if (!event) {
      if (digest === seen) continue;
      seen = digest;
      try { event = await stack.reload(); }
      catch (error) {
        if (signal?.aborted) return;
        event = { schema: 'blinkhost.local-artifact-reload/v1', status: 'rejected', config_sha256: digest,
          error: error instanceof Error && /^[a-z_]{1,96}$/.test(error.message)
            ? error.message : 'local_stack_reload_failed',
          previous_runtime_retained: stack.runtimeAvailable === true, production_authority: false };
      }
      if (event.status === 'unchanged') continue;
    }
    if (signal?.aborted) return;
    await onEvent(event);
  }
}
