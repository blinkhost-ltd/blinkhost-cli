import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { ApiClient } from './api.js';
import { readConfig, writeConfig } from './config.js';
import { CliError, EXIT } from './errors.js';
import { readProjectManifest, resolveLocalPath, validateProject } from './project.js';
import { readProjectLink } from './remote.js';
function takeOption(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
        throw new CliError(`${name} requires a value.`, EXIT.usage, 'missing_option_value');
    args.splice(index, 2);
    return value;
}
function takeFlag(args, name) { const i = args.indexOf(name); if (i < 0)
    return false; args.splice(i, 1); return true; }
function noExtra(args) { if (args.length)
    throw new CliError(`Unexpected argument: ${args[0]}`, EXIT.usage, 'unexpected_argument'); }
async function spawnInherited(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: env || process.env, shell: false, stdio: 'inherit', windowsHide: true });
        const forward = (signal) => child.kill(signal);
        process.once('SIGINT', forward);
        process.once('SIGTERM', forward);
        child.once('error', () => reject(new CliError(`The ${command} executable is unavailable.`, EXIT.filesystem, 'executable_unavailable')));
        child.once('exit', (code) => { process.off('SIGINT', forward); process.off('SIGTERM', forward); resolve(code ?? 1); });
    });
}
export async function runDev(input) {
    const args = [...input];
    const root = resolveLocalPath(args.shift());
    const host = takeOption(args, '--host');
    const port = takeOption(args, '--port');
    noExtra(args);
    const validation = await validateProject(root);
    if (validation.errors.length)
        throw new CliError('Project validation failed before local development started.', EXIT.validation, 'project_invalid', validation.errors);
    const manifest = validation.manifest;
    if (manifest.frontend.framework === 'html')
        throw new CliError('Static HTML projects do not define a development process. Use a local static-file server.', EXIT.validation, 'dev_command_unavailable');
    const manager = manifest.frontend.package_manager;
    const managerArgs = manager === 'npm' ? ['run', 'dev', '--'] : ['run', 'dev'];
    if (host)
        managerArgs.push('--host', host);
    if (port)
        managerArgs.push('--port', port);
    const dependencyRoot = manifest.frontend.dependency_root === '.' ? root : join(root, manifest.frontend.dependency_root);
    const exitCode = await spawnInherited(manager, managerArgs, dependencyRoot, { ...process.env, BLINKHOST_LOCAL: '1' });
    if (exitCode !== 0)
        throw new CliError(`The local development process exited with code ${exitCode}.`, EXIT.remote, 'dev_process_failed');
    return { exit_code: exitCode };
}
export async function testProject(input) {
    const args = [...input];
    const root = resolveLocalPath(args.shift());
    noExtra(args);
    const validation = await validateProject(root);
    if (validation.errors.length)
        throw new CliError('Project validation failed.', EXIT.validation, 'project_invalid', validation.errors);
    const manifest = validation.manifest;
    if (manifest.frontend.framework === 'html')
        return { validated: true, build: 'not_required' };
    const dependencyRoot = manifest.frontend.dependency_root === '.' ? root : join(root, manifest.frontend.dependency_root);
    const packageJson = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'));
    const script = packageJson.scripts?.test ? 'test' : 'build';
    const code = await spawnInherited(manifest.frontend.package_manager, ['run', script], dependencyRoot, { ...process.env, CI: '1' });
    if (code !== 0)
        throw new CliError(`Project ${script} exited with code ${code}.`, EXIT.validation, 'project_test_failed');
    return { validated: true, command: `${manifest.frontend.package_manager} run ${script}`, exit_code: code };
}
export async function observability(kind, input, profile) {
    const args = [...input];
    let project = takeOption(args, '--project');
    const since = takeOption(args, '--since');
    const limit = takeOption(args, '--limit');
    if (!project) {
        try {
            project = (await readProjectLink()).project_id;
        }
        catch { }
    }
    noExtra(args);
    if (!project)
        throw new CliError('Provide --project or link this directory with `blinkhost projects link`.', EXIT.usage, 'project_required');
    const query = new URLSearchParams();
    if (since)
        query.set('since', since);
    if (limit)
        query.set('limit', limit);
    const suffix = query.size ? `?${query}` : '';
    const client = await ApiClient.create(profile);
    return client.request(`/api/sites/${encodeURIComponent(project)}/observability/${kind}/${suffix}`);
}
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
export async function runPlugins(input) {
    const args = [...input];
    const action = args.shift() || 'list';
    const config = await readConfig();
    config.plugins ||= {};
    if (action === 'list') {
        noExtra(args);
        return { plugins: Object.entries(config.plugins).map(([name, value]) => ({ name, ...value })) };
    }
    if (action === 'add') {
        const source = args.shift();
        const requestedName = takeOption(args, '--name');
        noExtra(args);
        if (!source || !isAbsolute(source))
            throw new CliError('Plugin executables must use an absolute path.', EXIT.usage, 'plugin_absolute_path_required');
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
            throw new CliError('Plugin executables must be regular files and cannot be symbolic links.', EXIT.validation, 'invalid_plugin');
        const path = await realpath(source);
        const info = await lstat(path);
        if (!info.isFile())
            throw new CliError('Plugin executables must be regular files.', EXIT.validation, 'invalid_plugin');
        const name = requestedName || basename(path).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
            throw new CliError('Plugin names use lowercase letters, numbers, hyphens, and underscores.', EXIT.usage, 'invalid_plugin_name');
        config.plugins[name] = { executable: path, sha256: await sha256File(path), addedAt: new Date().toISOString() };
        await writeConfig(config);
        return { name, ...config.plugins[name] };
    }
    if (action === 'remove') {
        const name = args.shift();
        noExtra(args);
        if (!name || !config.plugins[name])
            throw new CliError('Plugin not found.', EXIT.usage, 'plugin_not_found');
        delete config.plugins[name];
        await writeConfig(config);
        return { removed: name };
    }
    if (action === 'verify' || action === 'run') {
        const name = args.shift();
        if (!name || !config.plugins[name])
            throw new CliError('Plugin not found.', EXIT.usage, 'plugin_not_found');
        const plugin = config.plugins[name];
        const current = await sha256File(plugin.executable);
        if (current !== plugin.sha256)
            throw new CliError('The plugin changed after approval. Remove and add it again only after reviewing the change.', EXIT.validation, 'plugin_integrity_failed');
        if (action === 'verify') {
            noExtra(args);
            return { name, verified: true, sha256: current };
        }
        const passthrough = args[0] === '--' ? args.slice(1) : args;
        const allowed = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP'];
        const env = { BLINKHOST_PLUGIN_PROTOCOL: '1' };
        for (const key of allowed)
            if (process.env[key])
                env[key] = process.env[key];
        const code = await spawnInherited(plugin.executable, passthrough, process.cwd(), env);
        if (code !== 0)
            throw new CliError(`Plugin ${name} exited with code ${code}.`, EXIT.remote, 'plugin_failed');
        return { name, exit_code: code };
    }
    throw new CliError(`Unknown plugins action: ${action}.`, EXIT.usage, 'unknown_action');
}
const COMPLETIONS = {
    bash: `complete -W "auth projects repositories connections dev previews builds deployments modules databases bindings assets secrets organizations templates approvals handoffs policies logs metrics analytics doctor support completion update ci plugins api" blinkhost`,
    zsh: `#compdef blinkhost\n_arguments '1:command:(auth projects repositories connections dev previews builds deployments modules databases bindings assets secrets organizations templates approvals handoffs policies logs metrics analytics doctor support completion update ci plugins api)'`,
    fish: `complete -c blinkhost -f -a "auth projects repositories connections dev previews builds deployments modules databases bindings assets secrets organizations templates approvals handoffs policies logs metrics analytics doctor support completion update ci plugins api"`,
    powershell: `Register-ArgumentCompleter -Native -CommandName blinkhost -ScriptBlock { param($wordToComplete) 'auth','projects','repositories','connections','dev','previews','builds','deployments','modules','databases','bindings','assets','secrets','organizations','templates','approvals','handoffs','policies','logs','metrics','analytics','doctor','support','completion','update','ci','plugins','api' | Where-Object { $_ -like "$wordToComplete*" } }`,
};
export function completion(shell) { if (!shell || !COMPLETIONS[shell])
    throw new CliError('Choose bash, zsh, fish, or powershell.', EXIT.usage, 'invalid_shell'); return `${COMPLETIONS[shell]}\n`; }
export async function checkForUpdate() {
    const response = await fetch('https://api.github.com/repos/blinkhost-ltd/blinkhost-cli/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BlinkHost-CLI/2.0.0' }, redirect: 'error' });
    if (!response.ok)
        throw new CliError('The release service could not be reached.', EXIT.network, 'update_check_failed');
    const data = await response.json();
    return { current_version: '2.0.0', latest_version: data.tag_name?.replace(/^v/, '') || null, release_url: data.html_url || null, automatic_install: false };
}
export async function ciCheck(profile) {
    const client = await ApiClient.create(profile);
    const capabilities = await client.request('/api/cli/v2/capabilities/');
    return { ready: true, token_source: process.env.BLINKHOST_ACCESS_TOKEN ? 'environment' : process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? 'github_oidc' : 'profile', capabilities };
}
export async function supportBundle(input, profile) {
    const args = [...input];
    const output = resolveLocalPath(takeOption(args, '--output') || `blinkhost-support-${Date.now()}.json`);
    noExtra(args);
    const root = process.cwd();
    let project = null;
    try {
        const manifest = await readProjectManifest(root);
        project = { schema: manifest.schema, framework: manifest.frontend.framework, package_manager: manifest.frontend.package_manager, module_languages: manifest.modules.map((item) => item.language), module_count: manifest.modules.length, database_count: manifest.resources.databases.length };
    }
    catch { }
    let api = { reachable: false };
    try {
        const client = await ApiClient.create(profile);
        const capabilities = await client.request('/api/cli/v2/capabilities/');
        api = { reachable: true, capabilities };
    }
    catch (error) {
        api = { reachable: false, error_code: error instanceof CliError ? error.code : 'unknown' };
    }
    const payload = { schema: 'blinkhost/support-bundle/v1', created_at: new Date().toISOString(), cli_version: '2.0.0', system: { platform: platform(), release: release(), node: process.versions.node, device_hash: createHash('sha256').update(hostname()).digest('hex').slice(0, 16) }, project, api };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { output, redacted: true };
}
//# sourceMappingURL=workflows.js.map