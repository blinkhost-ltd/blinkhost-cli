import type { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';

// Closed historical observations. This parser grants no serving/build authority.
export interface PreparationRelease {
  id: string;
  artifact_digest: string;
  backend_modules_digest: string;
  environment: { root_project_id: string };
  backend_modules_snapshot: Array<{
    module_id: string; name: string; artifact_digest: string; artifact_size_bytes: number;
  }>;
}

export interface PreparationAttempt {
  preparationId: string;
  moduleName: string;
  recordedAt: string;
  explanation: string;
}

export interface ReleasePreparationDiagnostics {
  state: 'available' | 'unavailable';
  attempts: PreparationAttempt[];
  truncated: boolean;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const releaseId = /^[1-9]\d{0,18}$/;
const sha256 = /^[0-9a-f]{64}$/;
const moduleName = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const envelopeKeys = ['schema_version', 'kind', 'deployment_id', 'project_id', 'release_digest',
  'backend_modules_digest', 'state', 'serving_readiness', 'attempts', 'truncated'];
const attemptKeys = ['schema_version', 'state', 'preparation_id', 'request_id', 'project_id',
  'release_digest', 'portable_sha256', 'portable_size_bytes', 'failure_diagnostic',
  'module_id', 'module_name', 'recorded_at'];
const diagnosticKeys = ['schema_version', 'stage', 'code', 'responsibility', 'resource', 'unit',
  'limit', 'observed', 'measurement', 'remediation'];
const policy = {
  memory: 8_589_934_592, cpu: 720_000_000_000, wall: 720,
  portable: 80_000_000, nativeMinimum: 67_108_864, nativeCeiling: 536_870_912, expansion: 4,
};
const currentWorker = { cpu: 600_000_000_000, wall: 600 };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function exact(row: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
}

function matches(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.exec(value)?.[0] === value;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function explanation(value: unknown, portable: number): string | undefined {
  const row = record(value);
  if (!row || ![1, 2].includes(row.schema_version as number) || row.stage !== 'native_preparation'
    || row.responsibility !== 'platform' || row.remediation !== 'contact_support') return undefined;
  const output = row.code === 'native_output_budget_exceeded';
  if (output && row.schema_version !== 1) return undefined;
  const worker = row.schema_version === 1 ? policy : currentWorker;
  if (!exact(row, output ? [...diagnosticKeys, 'portable_size_bytes'] : diagnosticKeys)) return undefined;
  const guidance = ' Contact BlinkHost support. Changing plans does not increase platform preparation limits.';
  if (output) {
    const limit = Math.min(policy.nativeCeiling, Math.max(policy.nativeMinimum, policy.expansion * portable));
    if (row.resource !== 'native_artifact' || row.unit !== 'bytes' || row.measurement !== 'measured_size'
      || row.portable_size_bytes !== portable || row.limit !== limit || !integer(row.observed, limit + 1)) return undefined;
    return `The platform native compiler generated ${row.observed} bytes, exceeding its ${limit}-byte output budget `
      + `for this ${portable}-byte portable module.` + guidance;
  }
  if (row.code === 'native_preparation_memory_exceeded') {
    if (row.resource !== 'compiler_memory' || row.unit !== 'bytes' || row.limit !== policy.memory
      || row.measurement !== (row.observed === null ? 'unavailable' : 'sampled_peak')
      || row.observed !== null && !integer(row.observed)) return undefined;
    return `The platform native compiler was stopped at its ${policy.memory}-byte memory allowance.`
      + (row.observed === null ? '' : ` Its sampled worker peak was ${row.observed} bytes.`) + guidance;
  }
  if (row.code === 'native_preparation_cpu_exceeded') {
    if (row.resource !== 'compiler_cpu' || row.unit !== 'nanoseconds' || row.limit !== worker.cpu
      || row.measurement !== (row.observed === null ? 'unavailable' : 'sampled_aggregate')
      || row.observed !== null && !integer(row.observed, worker.cpu + 1)) return undefined;
    let measured = '';
    if (typeof row.observed === 'number') {
      const whole = Math.floor(row.observed / 1_000_000_000);
      const fraction = String(row.observed % 1_000_000_000).padStart(9, '0').replace(/0+$/, '');
      measured = ` Its sampled aggregate CPU time was ${whole}${fraction ? '.' + fraction : ''} seconds.`;
    }
    return `The platform native compiler exceeded its ${worker.cpu / 1_000_000_000}-second aggregate CPU allowance.`
      + measured + guidance;
  }
  if (row.observed !== null || row.measurement !== 'unavailable') return undefined;
  if (row.code === 'native_preparation_deadline_exceeded') {
    if (row.resource !== 'compiler_wall_time' || row.unit !== 'seconds' || row.limit !== worker.wall) return undefined;
    return `The platform native compiler reached its ${worker.wall}-second preparation deadline.` + guidance;
  }
  if (row.code === 'native_preparation_child_failed' && row.resource === null && row.unit === null && row.limit === null) {
    return 'The platform native compiler could not finish preparing this module.' + guidance;
  }
  return undefined;
}

export function parseReleasePreparationDiagnostics(value: unknown, release: PreparationRelease): ReleasePreparationDiagnostics | undefined {
  const row = record(value);
  if (!row || !exact(row, envelopeKeys) || row.schema_version !== 1 || row.kind !== 'recorded_attempt_failures'
    || row.serving_readiness !== 'not_evaluated' || !matches(row.deployment_id, releaseId) || row.deployment_id !== release.id
    || !matches(row.project_id, uuid) || row.project_id !== release.environment.root_project_id
    || !matches(row.release_digest, sha256) || row.release_digest !== release.artifact_digest
    || !matches(row.backend_modules_digest, sha256) || row.backend_modules_digest !== release.backend_modules_digest
    || !['available', 'unavailable'].includes(row.state as string) || typeof row.truncated !== 'boolean'
    || !Array.isArray(row.attempts) || row.attempts.length > 50
    || row.state === 'unavailable' && (row.attempts.length !== 0 || row.truncated)) return undefined;
  if (!Array.isArray(release.backend_modules_snapshot) || release.backend_modules_snapshot.length > 100) return undefined;
  const modules = new Map<string, PreparationRelease['backend_modules_snapshot'][number]>();
  for (const artifact of release.backend_modules_snapshot) {
    if (!artifact || !matches(artifact.module_id, uuid) || modules.has(artifact.module_id) || !matches(artifact.name, moduleName)
      || !matches(artifact.artifact_digest, sha256) || !integer(artifact.artifact_size_bytes, 1, policy.portable)) return undefined;
    modules.set(artifact.module_id, artifact);
  }
  const preparations = new Set<string>();
  const requests = new Set<string>();
  const attempts: PreparationAttempt[] = [];
  for (const value of row.attempts) {
    const attempt = record(value);
    if (!attempt || !exact(attempt, attemptKeys) || attempt.schema_version !== 1 || attempt.state !== 'failed_preparation'
      || !matches(attempt.preparation_id, uuid) || preparations.has(attempt.preparation_id)
      || !matches(attempt.request_id, uuid) || requests.has(attempt.request_id)
      || attempt.project_id !== row.project_id || attempt.release_digest !== row.release_digest
      || !matches(attempt.module_id, uuid) || !matches(attempt.recorded_at, timestamp)
      || !Number.isFinite(Date.parse(attempt.recorded_at))) return undefined;
    const artifact = modules.get(attempt.module_id);
    if (!artifact || attempt.module_name !== artifact.name || attempt.portable_sha256 !== artifact.artifact_digest
      || attempt.portable_size_bytes !== artifact.artifact_size_bytes) return undefined;
    const text = explanation(attempt.failure_diagnostic, artifact.artifact_size_bytes);
    if (!text) return undefined;
    preparations.add(attempt.preparation_id);
    requests.add(attempt.request_id);
    attempts.push({ preparationId: attempt.preparation_id, moduleName: artifact.name,
      recordedAt: attempt.recorded_at, explanation: text });
  }
  return { state: row.state as ReleasePreparationDiagnostics['state'], attempts, truncated: row.truncated };
}

export function isPreparationDiagnosticsRead(path: string): boolean {
  return /^\/api\/deployments\/[1-9]\d{0,18}\/(?:preparation-diagnostics\/)?$/.exec(path)?.[0] === path;
}

function unavailable(): CliError {
  return new CliError('Preparation failure details are unavailable for this release.', EXIT.remote,
    'preparation_diagnostics_unavailable');
}

// This bounded transport is used only by the explicit historical read command.
// Failed HTTP bodies never supply error text, limits or request identities.
export async function readPreparationDiagnosticsResponse(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  let complete = false;
  try {
    if (response.status !== 200) return null;
    if (!reader || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw unavailable();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw unavailable();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let reads = 0; reads < 1024; reads++) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > limit) throw unavailable();
      chunks.push(chunk.value);
    }
    if (!complete || length !== null && Number(length) !== size) throw unavailable();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch {
    throw unavailable();
  } finally {
    if (!complete) void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

export async function loadReleasePreparationDiagnostics(client: ApiClient, id: string, project: string): Promise<{
  deploymentId: string; projectId: string; kind: 'recorded_attempt_failures';
  explanation: string; state: ReleasePreparationDiagnostics['state']; attempts: PreparationAttempt[]; truncated: boolean;
}> {
  try {
    const value = record(await client.request(`/api/deployments/${id}/`, {}, 512 * 1024));
    const environment = record(value?.environment);
    if (!value || value.id !== id || environment?.root_project_id !== project
      || !matches(value.artifact_digest, sha256) || !matches(value.backend_modules_digest, sha256)
      || !Array.isArray(value.backend_modules_snapshot)) throw unavailable();
    const release: PreparationRelease = {
      id, artifact_digest: value.artifact_digest, backend_modules_digest: value.backend_modules_digest,
      environment: { root_project_id: project }, backend_modules_snapshot: value.backend_modules_snapshot,
    };
    const data = await client.request(`/api/deployments/${id}/preparation-diagnostics/`, {}, 128 * 1024);
    const facts = parseReleasePreparationDiagnostics(data, release);
    if (!facts) throw unavailable();
    return { deploymentId: id, projectId: project, kind: 'recorded_attempt_failures',
      explanation: 'Past preparation failures do not describe current serving health or confirm native readiness.', ...facts };
  } catch (error) {
    if (error instanceof CliError) {
      const details = error.details.filter(detail => /^Request ID: [a-z0-9_.:-]{1,128}$/i.exec(detail)?.[0] === detail);
      throw new CliError('Preparation failure details are unavailable for this release.', error.exitCode, error.code, details);
    }
    throw unavailable();
  }
}
