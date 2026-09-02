import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { ApiClient } from './api.js';
import { activeProfile, readConfig, writeConfig } from './config.js';
import { CliError, EXIT } from './errors.js';
import { readProjectManifest, resolveLocalPath, validateProject } from './project.js';
import { readProjectLink } from './remote.js';
import { TOP_LEVEL_COMMANDS } from './guidance.js';
import { VERSION } from './version.js';

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith('--')) throw new CliError(`${name} requires a value.`, EXIT.usage, 'missing_option_value');
  args.splice(index, 2); return value;
}
function takeFlag(args: string[], name: string): boolean { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
function noExtra(args: string[]): void { if (args.length) throw new CliError(`Unexpected argument: ${args[0]}`, EXIT.usage, 'unexpected_argument'); }

async function spawnInherited(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, json = false): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env || process.env, shell: false, stdio: json ? ['inherit', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
    if (json) {
      child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    }
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once('SIGINT', forward); process.once('SIGTERM', forward);
    child.once('error', () => reject(new CliError(`The ${command} executable is unavailable.`, EXIT.filesystem, 'executable_unavailable')));
    child.once('exit', (code) => { process.off('SIGINT', forward); process.off('SIGTERM', forward); resolve(code ?? 1); });
  });
}

export async function runDev(input: string[], json = false): Promise<unknown> {
  const args = [...input]; const root = resolveLocalPath(args.shift()); const host = takeOption(args, '--host'); const port = takeOption(args, '--port'); noExtra(args);
  const validation = await validateProject(root);
  if (validation.errors.length) throw new CliError('Project validation failed before local development started.', EXIT.validation, 'project_invalid', validation.errors);
  const manifest = validation.manifest;
  if (manifest.frontend.framework === 'html') throw new CliError('Static HTML projects do not define a development process. Use a local static-file server.', EXIT.validation, 'dev_command_unavailable');
  const manager = manifest.frontend.package_manager;
  const managerArgs = manager === 'npm' ? ['run', 'dev', '--'] : ['run', 'dev'];
  if (host) managerArgs.push('--host', host);
  if (port) managerArgs.push('--port', port);
  const dependencyRoot = manifest.frontend.dependency_root === '.' ? root : join(root, manifest.frontend.dependency_root);
  const exitCode = await spawnInherited(manager, managerArgs, dependencyRoot, { ...process.env, BLINKHOST_LOCAL: '1' }, json);
  if (exitCode !== 0) throw new CliError(`The local development process exited with code ${exitCode}.`, EXIT.remote, 'dev_process_failed', [`If dependencies are missing, run \`${manager} install\` in ${dependencyRoot}, then retry.`]);
  return { exit_code: exitCode };
}

export async function testProject(input: string[], json = false): Promise<unknown> {
  const args = [...input]; const root = resolveLocalPath(args.shift()); noExtra(args);
  const validation = await validateProject(root);
  if (validation.errors.length) throw new CliError('Project validation failed.', EXIT.validation, 'project_invalid', validation.errors);
  const manifest = validation.manifest;
  if (manifest.frontend.framework === 'html') return { validated: true, build: 'not_required' };
  const dependencyRoot = manifest.frontend.dependency_root === '.' ? root : join(root, manifest.frontend.dependency_root);
  const packageJson = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.test ? 'test' : 'build';
  const code = await spawnInherited(manifest.frontend.package_manager, ['run', script], dependencyRoot, { ...process.env, CI: '1' }, json);
  if (code !== 0) throw new CliError(`Project ${script} exited with code ${code}.`, EXIT.validation, 'project_test_failed', [`If dependencies are missing, run \`${manifest.frontend.package_manager} install\` in ${dependencyRoot}, then retry.`]);
  return { validated: true, command: `${manifest.frontend.package_manager} run ${script}`, exit_code: code };
}

export async function observability(kind: 'logs' | 'metrics' | 'analytics', input: string[], profile?: string): Promise<unknown> {
  const args = [...input];
  let project = takeOption(args, '--project');
  const since = takeOption(args, '--since'); const limit = takeOption(args, '--limit');
  if (!project) { try { project = (await readProjectLink()).project_id; } catch {} }
  noExtra(args);
  if (!project) throw new CliError('Provide --project or link this directory with `blinkhost projects link`.', EXIT.usage, 'project_required');
  const query = new URLSearchParams(); if (since) query.set('since', since); if (limit) query.set('limit', limit);
  const suffix = query.size ? `?${query}` : '';
  const client = await ApiClient.create(profile);
  return client.request(`/api/sites/${encodeURIComponent(project)}/observability/${kind}/${suffix}`);
}

async function sha256File(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex'); }

export async function runPlugins(input: string[], json = false): Promise<unknown> {
  const args = [...input]; const action = args.shift() || 'list'; const config = await readConfig(); config.plugins ||= {};
  if (action === 'list') { noExtra(args); return { plugins: Object.entries(config.plugins).map(([name, value]) => ({ name, ...value })) }; }
  if (action === 'add') {
    const source = args.shift(); const requestedName = takeOption(args, '--name'); noExtra(args);
    if (!source || !isAbsolute(source)) throw new CliError('Plugin executables must use an absolute path.', EXIT.usage, 'plugin_absolute_path_required');
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new CliError('Plugin executables must be regular files and cannot be symbolic links.', EXIT.validation, 'invalid_plugin');
    const path = await realpath(source); const info = await lstat(path);
    if (!info.isFile()) throw new CliError('Plugin executables must be regular files.', EXIT.validation, 'invalid_plugin');
    const name = requestedName || basename(path).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new CliError('Plugin names use lowercase letters, numbers, hyphens, and underscores.', EXIT.usage, 'invalid_plugin_name');
    config.plugins[name] = { executable: path, sha256: await sha256File(path), addedAt: new Date().toISOString() };
    await writeConfig(config); return { name, ...config.plugins[name] };
  }
  if (action === 'remove') { const name = args.shift(); noExtra(args); if (!name || !config.plugins[name]) throw new CliError('Plugin not found.', EXIT.usage, 'plugin_not_found'); delete config.plugins[name]; await writeConfig(config); return { removed: name }; }
  if (action === 'verify' || action === 'run') {
    const name = args.shift(); if (!name || !config.plugins[name]) throw new CliError('Plugin not found.', EXIT.usage, 'plugin_not_found');
    const plugin = config.plugins[name]; const current = await sha256File(plugin.executable);
    if (current !== plugin.sha256) throw new CliError('The plugin changed after approval. Remove and add it again only after reviewing the change.', EXIT.validation, 'plugin_integrity_failed');
    if (action === 'verify') { noExtra(args); return { name, verified: true, sha256: current }; }
    const passthrough = args[0] === '--' ? args.slice(1) : args;
    const allowed = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP']; const env: NodeJS.ProcessEnv = { BLINKHOST_PLUGIN_PROTOCOL: '1' };
    for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
    const code = await spawnInherited(plugin.executable, passthrough, process.cwd(), env, json);
    if (code !== 0) throw new CliError(`Plugin ${name} exited with code ${code}.`, EXIT.remote, 'plugin_failed');
    return { name, exit_code: code };
  }
  throw new CliError(`Unknown plugins action: ${action}.`, EXIT.usage, 'unknown_action');
}

const commandWords = TOP_LEVEL_COMMANDS.join(' ');
const powershellCommands = TOP_LEVEL_COMMANDS.map((command) => `'${command}'`).join(',');
const COMPLETIONS: Record<string, string> = {
  bash: `complete -W "${commandWords}" blinkhost`,
  zsh: `#compdef blinkhost\n_arguments '1:command:(${commandWords})'`,
  fish: `complete -c blinkhost -f -a "${commandWords}"`,
  powershell: `Register-ArgumentCompleter -Native -CommandName blinkhost -ScriptBlock { param($wordToComplete) ${powershellCommands} | Where-Object { $_ -like "$wordToComplete*" } }`,
};

export function completion(shell: string | undefined): string { if (!shell || !COMPLETIONS[shell]) throw new CliError('Choose bash, zsh, fish, or powershell.', EXIT.usage, 'invalid_shell'); return `${COMPLETIONS[shell]}\n`; }

interface ReleaseCheck {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  affected?: boolean;
  impact?: string;
  requires_action?: boolean;
  summary?: string;
  release_url?: string;
  migration_url?: string;
  install_command?: string;
  automatic_install: false;
}

function versionTuple(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function newerThan(candidate: string, current: string): boolean {
  const left = versionTuple(candidate); const right = versionTuple(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    const candidatePart = left[index] ?? 0; const currentPart = right[index] ?? 0;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  return false;
}

async function releaseRequest(path: string, profile?: string, timeoutMs = 3000): Promise<Response> {
  const selected = await activeProfile(profile);
  return fetch(`${selected.profile.apiOrigin}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': `BlinkHost-CLI/${VERSION}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function checkForUpdate(profile?: string, timeoutMs = 3000): Promise<ReleaseCheck> {
  const query = new URLSearchParams({ component: 'cli', channel: 'stable', current_version: VERSION });
  const response = await releaseRequest(`/api/documentation/releases/latest/?${query}`, profile, timeoutMs);
  if (!response.ok) throw new CliError('The release service could not be reached.', EXIT.network, 'update_check_failed');
  const data = await response.json() as Omit<ReleaseCheck, 'automatic_install'>;
  return { ...data, current_version: VERSION, automatic_install: false };
}

export async function releaseNotes(version?: string, profile?: string): Promise<unknown> {
  const query = new URLSearchParams({ component: 'cli', channel: 'stable' });
  const response = await releaseRequest(`/api/documentation/releases/?${query}`, profile);
  if (!response.ok) throw new CliError('Release notes could not be loaded.', EXIT.network, 'release_notes_failed');
  const payload = await response.json() as unknown;
  const rows = Array.isArray(payload) ? payload : ((payload as { results?: unknown[] }).results || []);
  const releases = rows.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (version) {
    const selected = releases.find((item) => item.version === version);
    if (!selected) throw new CliError(`No published CLI release notes were found for ${version}.`, EXIT.remote, 'release_not_found');
    return selected;
  }
  return { component: 'cli', releases };
}

export async function maybeUpdateNotice(profile?: string): Promise<string | null> {
  if (!process.stderr.isTTY || process.env.CI || process.env.BLINKHOST_NO_UPDATE_NOTIFIER === '1') return null;
  const selected = await activeProfile(profile);
  if (selected.config.updateNotifications === false) return null;
  const checkedAt = selected.config.updateCheckedAt ? Date.parse(selected.config.updateCheckedAt) : 0;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < 48 * 60 * 60 * 1000) return null;
  try {
    const result = await checkForUpdate(profile, 500);
    selected.config.updateCheckedAt = new Date().toISOString();
    if (result.latest_version) selected.config.latestVersion = result.latest_version;
    else delete selected.config.latestVersion;
    if (result.release_url) selected.config.latestReleaseUrl = result.release_url;
    else delete selected.config.latestReleaseUrl;
    await writeConfig(selected.config);
    if (!result.latest_version || !newerThan(result.latest_version, VERSION)) return null;
    const instruction = result.install_command || `npm install --global @blinkhost/cli@${result.latest_version}`;
    return `BlinkHost CLI ${result.latest_version} is available. Run ${instruction} or \`blinkhost update notes ${result.latest_version}\`.`;
  } catch {
    return null;
  }
}

export async function ciCheck(profile?: string): Promise<unknown> {
  const client = await ApiClient.create(profile);
  const capabilities = await client.request('/api/cli/v2/capabilities/');
  return { ready: true, token_source: process.env.BLINKHOST_ACCESS_TOKEN ? 'environment' : process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? 'github_oidc' : 'profile', capabilities };
}

export async function supportBundle(input: string[], profile?: string): Promise<unknown> {
  const args = [...input]; const output = resolveLocalPath(takeOption(args, '--output') || `blinkhost-support-${Date.now()}.json`); noExtra(args);
  const root = process.cwd(); let project: unknown = null;
  try { const manifest = await readProjectManifest(root); project = { schema: manifest.schema, framework: manifest.frontend.framework, package_manager: manifest.frontend.package_manager, module_languages: manifest.modules.map((item) => item.language), module_count: manifest.modules.length, database_count: manifest.resources.databases.length }; } catch {}
  let api: unknown = { reachable: false };
  try { const client = await ApiClient.create(profile); const capabilities = await client.request('/api/cli/v2/capabilities/'); api = { reachable: true, capabilities }; } catch (error) { api = { reachable: false, error_code: error instanceof CliError ? error.code : 'unknown' }; }
  const payload = { schema: 'blinkhost/support-bundle/v1', created_at: new Date().toISOString(), cli_version: VERSION, system: { platform: platform(), release: release(), node: process.versions.node, device_hash: createHash('sha256').update(hostname()).digest('hex').slice(0, 16) }, project, api };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { output, redacted: true };
}
