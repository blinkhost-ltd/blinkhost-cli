// Build rejection facts explain a failed request; they never authorize a build.
// Only closed labels and bounded numeric measurements may reach the terminal.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BUILD_PATH = new RegExp(`^/api/idam/projects/${UUID}/module-builds/(?:review/|reviews/${UUID}/(?:apply/)?)?$`, 'i');

export function isModuleBuildPath(path: string): boolean {
  return BUILD_PATH.test(path);
}

export function moduleBuildPortableFailureGuidance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope = payload as Record<string, unknown>;
  if (envelope.build_state !== 'failed_user' || envelope.artifact_id !== null || !envelope.build_id) return;
  const value = envelope.failure_diagnostic;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const fields = ['schema_version', 'stage', 'resource', 'observed', 'limit', 'unit', 'measurement'];
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
      || row.schema_version !== 1 || row.stage !== 'portable_compilation' || row.resource !== 'portable_artifact'
      || row.unit !== 'bytes' || row.measurement !== 'lower_bound'
      || !Number.isSafeInteger(row.observed) || !Number.isSafeInteger(row.limit)
      || (row.limit as number) <= 0 || (row.limit as number) > 80_000_000
      || (row.observed as number) <= (row.limit as number)) return;
  return `The compiled portable WebAssembly module contains at least ${row.observed} bytes; `
    + `its admitted maximum is ${row.limit} bytes. Reduce bundled code or dependencies and build again.`;
}

const RESOURCES = {
  source_expanded_bytes: { label: 'Backend module source', unit: 'bytes' },
  source_archive_bytes: { label: 'Backend module source archive', unit: 'bytes' },
  source_files: { label: 'Backend module source', unit: 'files' },
} as const;

export function moduleBuildGuestMemoryFailureGuidance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope = payload as Record<string, unknown>;
  if (envelope.build_state !== 'failed_user' || envelope.artifact_id !== null
      || typeof envelope.build_id !== 'string'
      || new RegExp(`^${UUID}$`, 'i').exec(envelope.build_id)?.[0] !== envelope.build_id) return;
  const value = envelope.failure_diagnostic;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const fields = ['schema_version', 'stage', 'resource', 'observed', 'limit', 'unit', 'measurement',
    'minimum_memory_bytes', 'maximum_memory_bytes'];
  const memory = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)
    && n >= 0 && n <= 2 ** 32 && n % 65536 === 0;
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
      || row.schema_version !== 1 || row.stage !== 'portable_validation' || row.resource !== 'guest_memory'
      || row.unit !== 'bytes' || row.measurement !== 'declared_memory'
      || (row.limit !== 134217728 && row.limit !== 536870912)
      || !memory(row.minimum_memory_bytes)
      || (row.maximum_memory_bytes !== null && (!memory(row.maximum_memory_bytes)
        || row.maximum_memory_bytes < row.minimum_memory_bytes))
      || row.observed !== (row.maximum_memory_bytes ?? row.minimum_memory_bytes)
      || !memory(row.observed) || row.observed <= row.limit) return;
  const maximum = row.maximum_memory_bytes === null ? 'no declared maximum'
    : `a declared maximum of ${row.maximum_memory_bytes} bytes`;
  return `The portable WebAssembly module declares ${row.minimum_memory_bytes} bytes of initial guest memory and ${maximum}; `
    + `its admitted guest-memory cap is ${row.limit} bytes. Reduce the module's initial or maximum memory settings and build again. `
    + 'This is a module declaration, not measured runtime or compiler memory. Paid shared plans do not increase the guest-memory cap.';
}

const packageMessages = Object.freeze({
  BHPY_DEPENDENCIES_UNSUPPORTED: "This Python build does not install dependencies from package manifests. Use the shipped libraries or supported local Python modules and build again.",
  BHPY_NATIVE_PACKAGE_UNSUPPORTED: "This Python build does not accept wheels, native extensions, object files or prebuilt WebAssembly. Use supported Python source and shipped libraries and build again.",
  BHPY_UNSUPPORTED_IMPORT: "This Python build imports a module outside the supported import set. Use shipped libraries, supported customer helpers or local Python modules and build again.",
  BHPY_DYNAMIC_IMPORT_UNSUPPORTED: "This Python build uses an unsupported dynamic import. Use explicit supported imports and build again.",
  BHJS_PACKAGE_MANIFEST: "This build has an invalid package manifest. Correct the dependency and script declarations in package.json and build again.",
  BHJS_LIFECYCLE_SCRIPT_UNSUPPORTED: "This build declares a package lifecycle script that function builds do not allow. Remove the lifecycle script and use dependencies that work without install scripts, then build again.",
  BHJS_PACKAGE_VERSION_UNCERTIFIED: "This build declares or resolves a dependency version outside the compatibility registry. Choose an exact supported version, update package.json and package-lock.json together, and build again.",
  BHJS_LOCKFILE_REQUIRED: "This build is missing package-lock.json. Generate and commit a lockfile using supported exact dependency versions, then build again.",
  BHJS_LOCKFILE_INVALID: "This build has an invalid dependency lockfile. Regenerate and commit package-lock.json using supported exact dependency versions, then build again.",
  BHJS_NATIVE_ADDON_UNSUPPORTED: "This module's JavaScript runtime does not load native addons. Use a compatible JavaScript dependency and build again.",
  BHJS_PACKAGE_UNCERTIFIED: "This build resolves a dependency outside the compatibility registry. Use a supported dependency and build again.",
  BHJS_NODE_API_UNSUPPORTED: "This module's JavaScript runtime does not provide the requested Node.js operating-system API. Use supported runtime APIs or a compatible dependency and build again.",
  BHJS_EXTERNAL_IMPORT_UNSUPPORTED: "This build contains an unavailable external import. Bundle supported dependencies or use supported runtime APIs and build again.",
  BHJS_DYNAMIC_IMPORT_UNSUPPORTED: "This build uses an unsupported dynamic import. Use static imports of supported dependencies and build again.",
} as const);

export function moduleBuildPackageFailureGuidance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope = payload as Record<string, unknown>;
  if (envelope.build_state !== 'failed_user' || envelope.artifact_id !== null
      || typeof envelope.build_id !== 'string'
      || new RegExp(`^${UUID}$`, 'i').exec(envelope.build_id)?.[0] !== envelope.build_id) return;
  const diagnostic = envelope.failure_diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return;
  const row = diagnostic as Record<string, unknown>;
  const packageFields = ['schema_version', 'stage', 'resource', 'language', 'code'];
  if (Object.keys(row).length !== packageFields.length || packageFields.some(field => !Object.hasOwn(row, field))
      || row.schema_version !== 1 || row.stage !== 'source_compatibility' || row.resource !== 'package_compatibility'
      || typeof row.code !== 'string' || !Object.hasOwn(packageMessages, row.code)
      || !((row.language === 'python-wasi' && row.code.startsWith('BHPY_'))
        || (['javascript-wasi', 'typescript-wasi'].includes(row.language as string) && row.code.startsWith('BHJS_')))) return;
  return packageMessages[row.code as keyof typeof packageMessages];
}

export function moduleBuildFailureGuidance(payload: unknown): string | undefined {
  return moduleBuildPortableFailureGuidance(payload) ?? moduleBuildGuestMemoryFailureGuidance(payload)
    ?? moduleBuildPackageFailureGuidance(payload);
}

export function moduleBuildSourceGuidance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope = payload as Record<string, unknown>;
  const value = envelope.source_limit;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1 || typeof row.resource !== 'string' || !Object.hasOwn(RESOURCES, row.resource)
      || typeof row.stage !== 'string' || !['source_collection', 'source_archive', 'source_admission'].includes(row.stage)
      || typeof row.measurement !== 'string' || !['exact', 'lower_bound', 'attempted_write'].includes(row.measurement)
      || !Number.isSafeInteger(row.observed) || !Number.isSafeInteger(row.limit)
      || (row.limit as number) <= 0 || (row.observed as number) <= (row.limit as number)) return;
  const resource = row.resource as keyof typeof RESOURCES;
  if (row.unit !== RESOURCES[resource].unit
      || (row.stage === 'source_archive') !== (row.measurement === 'attempted_write')
      || row.stage === 'source_archive' && resource !== 'source_archive_bytes') return;
  const code = row.stage === 'source_admission' ? 'build_authorization_changed'
    : row.stage === 'source_archive' ? 'module_source_archive_too_large'
    : resource === 'source_files' ? 'module_source_file_limit'
    : resource === 'source_expanded_bytes' ? 'module_source_too_large' : undefined;
  if (!code || envelope.code !== code) return;
  const amount = row.measurement === 'exact' ? String(row.observed) : `at least ${row.observed}`;
  const verb = row.measurement === 'attempted_write' ? 'would contain' : 'contains';
  return `${RESOURCES[resource].label} ${verb} ${amount} ${row.unit}; the maximum is ${row.limit} ${row.unit}. `
    + 'Reduce the source size or file count and try again.';
}

export function moduleBuildQuotaGuidance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const envelope = payload as Record<string, unknown>;
  if (envelope.code !== 'concurrent_build_limit_reached') return;
  const value = envelope.build_limit;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const fields = ['schema_version', 'stage', 'resource', 'scope', 'observed', 'limit', 'unit', 'measurement'];
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
      || row.schema_version !== 1 || row.stage !== 'build_admission' || row.resource !== 'concurrent_builds'
      || row.scope !== 'workspace' || row.unit !== 'builds' || row.measurement !== 'occupied_slots_snapshot'
      || !Number.isSafeInteger(row.observed) || !Number.isSafeInteger(row.limit)
      || (row.limit as number) < 0 || (row.observed as number) < (row.limit as number)) return;
  const remedy = row.limit === 0
    ? 'Builds are disabled by this workspace\'s current concurrent-build limit. Check workspace build access before trying again.'
    : 'Wait for an existing build to stop, then retry.';
  return `This workspace had ${row.observed} occupied build slots when this build was rejected; `
    + `its concurrent-build limit is ${row.limit}. ${remedy} This limit applies to builds, not backend requests.`;
}

export function moduleBuildRejectionGuidance(payload: unknown): string | undefined {
  return moduleBuildQuotaGuidance(payload) ?? moduleBuildSourceGuidance(payload);
}

export async function readModuleBuildRejection(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let complete = false;
  try {
    // The reviewed-build API uses HTTP 409 for confirmed lifecycle rejection.
    // Unconfirmed errors, auth failures and HTML never supply limit guidance.
    if (response.status !== 409
        || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let reads = 0; reads < 64; reads++) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > 2048) return;
      chunks.push(chunk.value);
    }
    if (!complete || length !== null && Number(length) !== size) return;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch {
    // Broken or malformed error bodies retain the generic confirmed HTTP error.
    return;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function moduleBuildRequestId(candidate: string | null, fallback: string): string {
  const safe = (value: string): boolean => /^[a-z0-9_.:-]{1,128}$/i.test(value);
  return candidate !== null && safe(candidate) ? candidate : safe(fallback) ? fallback : 'unavailable';
}
