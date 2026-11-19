import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CliError, EXIT } from './errors.js';
import { localCheckDirectory } from './local-test-config.js';
import { runLocalTestCommand, type LocalTestCommandResult } from './local-test-command.js';

export const LOCAL_SOURCE_LIMITS = {
  configBytes: 65_536, files: 1024, sourceBytes: 64 * 1024 * 1024,
  executableBytes: 256 * 1024 * 1024, artifactBytes: 20_000_000,
  timeoutMs: 300_000, maxTimeoutMs: 900_000, outputBytes: 1_048_576,
} as const;

interface SourceBuildConfig {
  schema: 'blinkhost.local-source-build/v1';
  source_root: string;
  files: string[];
  command: { path: string; sha256: string };
  args: string[];
  artifact: string;
  timeout_ms?: number;
}
export interface LocalSourceBuildReceipt {
  schema: 'blinkhost.local-source-build-result/v1';
  status: 'compiled' | 'rejected';
  config_sha256: string;
  command_sha256: string;
  source_sha256: Record<string, string>;
  artifact: { path: string; sha256: string; bytes: number } | null;
  execution: LocalTestCommandResult | null;
  error?: string;
  validation: 'portable_header_only';
  sandbox: 'customer_command_no_sandbox';
  production_authority: false;
}

function fail(code: string): never {
  throw new CliError('Local source compilation failed. Inspect the retained build result and check your explicit compiler configuration.',
    EXIT.validation, code);
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_local_source_build_config');
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => ![...required, ...optional].includes(key))) {
    fail('invalid_local_source_build_config');
  }
  return row;
}
function projectFile(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value || isAbsolute(value)
    || /[\u0000-\u001f\u007f\\]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_local_source_build_path');
  return value;
}

/** Regular, bounded files only; nonblocking open also refuses FIFO races. */
async function readBounded(filename: string, maximum: number, collect = true): Promise<{ bytes: Buffer; sha256: string; size: number }> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('invalid_local_source_build_file');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum || before.ino !== info.ino || before.dev !== info.dev) fail('local_source_build_file_raced');
    const digest = createHash('sha256'), chunks: Buffer[] = [];
    const buffer = Buffer.alloc(131_072);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maximum - size + 1), size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum) fail('invalid_local_source_build_file');
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (collect) chunks.push(Buffer.from(bytes));
    }
    const after = await file.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) fail('local_source_build_file_raced');
    return { bytes: Buffer.concat(chunks), sha256: digest.digest('hex'), size };
  } finally { await file.close(); }
}

async function sourceFile(root: string, name: string): Promise<string> {
  const safe = projectFile(name);
  await localCheckDirectory(root, dirname(safe));
  return join(root, safe);
}

export async function readSourceStackConfiguration(filename: string): Promise<{ value: Record<string, unknown>; sha256: string }> {
  const input = await readBounded(filename, LOCAL_SOURCE_LIMITS.configBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)); }
  catch { fail('invalid_local_stack_configuration'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_local_stack_configuration');
  return { value: value as Record<string, unknown>, sha256: input.sha256 };
}

/** Compile one explicit, immutable source snapshot. Commands are trusted customer code. */
export async function buildLocalSource(root: string, filename: string, directory: string,
  { signal }: { signal?: AbortSignal } = {}): Promise<LocalSourceBuildReceipt> {
  if (process.platform !== 'linux') fail('local_source_build_platform_unsupported');
  root = await realpath(root);
  const configPath = await sourceFile(root, relative(root, resolve(root, filename)));
  const configInput = await readBounded(configPath, LOCAL_SOURCE_LIMITS.configBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configInput.bytes)); }
  catch { fail('invalid_local_source_build_config'); }
  const row = object(value, ['schema', 'source_root', 'files', 'command', 'args', 'artifact'], ['timeout_ms']);
  if (row.schema !== 'blinkhost.local-source-build/v1') fail('unsupported_local_source_build_schema');
  await localCheckDirectory(root, row.source_root);
  if (!Array.isArray(row.files) || !row.files.length || row.files.length > LOCAL_SOURCE_LIMITS.files
    || new Set(row.files).size !== row.files.length) fail('invalid_local_source_build_files');
  row.files.forEach(projectFile);
  const command = object(row.command, ['path', 'sha256']);
  if (typeof command.path !== 'string' || !command.path || command.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(command.path)
    || typeof command.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(command.sha256)) fail('invalid_local_source_build_command');
  if (!Array.isArray(row.args) || row.args.length > 64 || row.args.some(arg => typeof arg !== 'string'
    || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))
    || row.args.reduce((sum, arg: string) => sum + Buffer.byteLength(arg), 0) > 32_768) fail('invalid_local_source_build_args');
  if (typeof row.artifact !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.wasm$/.test(row.artifact)) fail('invalid_local_source_build_artifact');
  const timeout = row.timeout_ms ?? LOCAL_SOURCE_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > LOCAL_SOURCE_LIMITS.maxTimeoutMs) fail('invalid_local_source_build_timeout');
  const config = row as unknown as SourceBuildConfig;
  const executable = resolve(root, config.command.path);
  if ((await readBounded(executable, LOCAL_SOURCE_LIMITS.executableBytes, false)).sha256 !== config.command.sha256) fail('local_source_build_command_digest_mismatch');
  const sourceRoot = resolve(root, config.source_root);
  const inputs: Array<{ name: string; path: string; bytes: Buffer; sha256: string }> = [];
  let sourceBytes = 0;
  for (const name of [...config.files].sort()) {
    if (signal?.aborted) fail('local_source_build_cancelled');
    const path = await sourceFile(sourceRoot, name);
    const input = await readBounded(path, LOCAL_SOURCE_LIMITS.sourceBytes - sourceBytes);
    sourceBytes += input.bytes.length;
    inputs.push({ name, path, ...input });
  }
  directory = resolve(directory);
  // Refuse to put retained build state inside the application's source tree.
  const offset = relative(sourceRoot, directory);
  if (!offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('../'))) fail('local_source_build_state_in_source');
  await mkdir(directory, { mode: 0o700 });
  directory = await realpath(directory);
  const source = join(directory, 'source'), output = join(directory, 'output'), temp = join(directory, 'tmp');
  await mkdir(source, { mode: 0o755 }); await mkdir(output, { mode: 0o755 }); await mkdir(temp, { mode: 0o755 });
  const receipt: LocalSourceBuildReceipt = {
    schema: 'blinkhost.local-source-build-result/v1', status: 'rejected', config_sha256: configInput.sha256,
    command_sha256: config.command.sha256, source_sha256: Object.fromEntries(inputs.map(item => [item.name, item.sha256])),
    artifact: null, execution: null, validation: 'portable_header_only', sandbox: 'customer_command_no_sandbox', production_authority: false,
  };
  try {
    for (const input of inputs) {
      await mkdir(dirname(join(source, input.name)), { recursive: true, mode: 0o755 });
      await writeFile(join(source, input.name), input.bytes, { flag: 'wx', mode: 0o644 });
    }
    receipt.execution = await runLocalTestCommand(executable, config.args, {
      cwd: source, timeoutMs: Number(timeout), maxOutputBytes: LOCAL_SOURCE_LIMITS.outputBytes, ...(signal ? { signal } : {}),
      env: { PATH: dirname(executable) + ':/usr/bin:/bin', LC_ALL: 'C.UTF-8', TZ: 'UTC', TMPDIR: temp,
        BLINKHOST_LOCAL_BUILD_SOURCE: source, BLINKHOST_LOCAL_BUILD_OUTPUT: output,
        BLINKHOST_LOCAL_BUILD_ARTIFACT: join(output, config.artifact) },
    });
    if (receipt.execution.status !== 'succeeded') fail('local_source_build_' + receipt.execution.status);
    if (signal?.aborted) fail('local_source_build_cancelled');
    for (const owned of [directory, source, output, temp]) {
      const info = await lstat(owned);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('local_source_build_directory_changed');
    }
    if ((await readBounded(configPath, LOCAL_SOURCE_LIMITS.configBytes)).sha256 !== configInput.sha256) fail('local_source_build_configuration_changed');
    if ((await readBounded(executable, LOCAL_SOURCE_LIMITS.executableBytes, false)).sha256 !== config.command.sha256) fail('local_source_build_command_changed');
    for (const input of inputs) {
      if ((await readBounded(input.path, LOCAL_SOURCE_LIMITS.sourceBytes)).sha256 !== input.sha256
        || (await readBounded(await sourceFile(source, input.name), LOCAL_SOURCE_LIMITS.sourceBytes)).sha256 !== input.sha256) fail('local_source_build_source_changed');
    }
    const artifact = await readBounded(join(output, config.artifact), LOCAL_SOURCE_LIMITS.artifactBytes);
    if (!artifact.bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('local_source_build_invalid_portable_header');
    const accepted = join(directory, 'compiled.wasm');
    await writeFile(accepted, artifact.bytes, { flag: 'wx', mode: 0o600 });
    receipt.status = 'compiled';
    receipt.artifact = { path: accepted, sha256: hash(artifact.bytes), bytes: artifact.bytes.length };
    return receipt;
  } catch (error) {
    receipt.error = error instanceof CliError ? error.code : 'local_source_build_failed';
    throw error;
  } finally {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) fail('local_source_build_directory_changed');
    await writeFile(join(directory, 'build-result.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}

/** Watch only the initial explicit input list; build configuration changes require a new run. */
export async function fingerprintLocalSource(root: string, filename: string, baseline: LocalSourceBuildReceipt,
  signal?: AbortSignal): Promise<string> {
  root = await realpath(root);
  const configPath = await sourceFile(root, relative(root, resolve(root, filename)));
  const input = await readBounded(configPath, LOCAL_SOURCE_LIMITS.configBytes);
  if (input.sha256 !== baseline.config_sha256) fail('local_source_build_configuration_changed');
  const config = JSON.parse(input.bytes.toString('utf8')) as SourceBuildConfig;
  await localCheckDirectory(root, config.source_root);
  const sourceRoot = resolve(root, config.source_root);
  const hashes: Record<string, string> = {};
  let bytes = 0;
  for (const name of Object.keys(baseline.source_sha256).sort()) {
    if (signal?.aborted) fail('local_source_build_cancelled');
    const value = await readBounded(await sourceFile(sourceRoot, name), LOCAL_SOURCE_LIMITS.sourceBytes - bytes, false);
    bytes += value.size;
    hashes[name] = value.sha256;
  }
  return localSourceFingerprint(hashes);
}

export function localSourceFingerprint(hashes: Record<string, string>): string {
  return hash(Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(hashes).sort().map(name => [name, hashes[name]])))));
}
