#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CliError, EXIT } from './errors.js';
import { SUPPORTED_FRONTENDS, SUPPORTED_MANAGERS, SUPPORTED_MODULES, } from './manifest.js';
import { detectManifest } from './detect.js';
import { readProjectManifest, resolveLocalPath, validateProject, writeManifest, writeScaffoldAtomically } from './project.js';
import { createScaffold } from './templates.js';
import { ApiClient } from './api.js';
import { login, logout } from './auth.js';
import { activeProfile, readConfig, validateProfileName, writeConfig } from './config.js';
import { openPreview, projectStatus, rawApi, readProjectLink, runRemote, runSecrets, syncProject, unlinkProject, uploadAsset, waitForRemote, writeProjectLink } from './remote.js';
import { checkForUpdate, ciCheck, completion, observability, runDev, runPlugins, supportBundle, testProject } from './workflows.js';
import { documentationIndex, documentationTopic, quickstart, renderTopHelp, renderTopic, searchDocumentation, TOP_LEVEL_COMMANDS } from './guidance.js';
import { VERSION, supportedNodeVersion } from './version.js';
let quietOutput = false;
let verboseOutput = false;
function terminalText(value) {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
function emit(output, json) {
    if (json)
        process.stdout.write(`${JSON.stringify(output)}\n`);
    else {
        if (quietOutput)
            return;
        process.stdout.write(`${terminalText(output.message)}\n`);
        if (output.data !== undefined && output.data !== null) {
            process.stdout.write(`${terminalText(JSON.stringify(output.data, null, 2))}\n`);
        }
        for (const warning of output.warnings ?? [])
            process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    }
}
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
function takeRepeatedOption(args, name) {
    const values = [];
    let index = args.indexOf(name);
    while (index >= 0) {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            throw new CliError(`${name} requires a value.`, EXIT.usage, 'missing_option_value');
        values.push(value);
        args.splice(index, 2);
        index = args.indexOf(name);
    }
    return values;
}
function takeFlag(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return false;
    args.splice(index, 1);
    return true;
}
function assertNoUnknown(args) {
    if (args.length)
        throw new CliError(`Unexpected argument: ${args[0]}`, EXIT.usage, 'unexpected_argument');
}
function parseModule(value) {
    const [name, language, extra] = value.split(':');
    if (extra || !name || !language || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || !SUPPORTED_MODULES.includes(language)) {
        throw new CliError('Use --module name:language with a safe name and python, go or rust.', EXIT.usage, 'invalid_module');
    }
    return { name, language: language };
}
async function runProcess(command, args, cwd, json = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, stdio: json ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, npm_config_ignore_scripts: 'true' } });
        if (json) {
            child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
            child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        }
        child.once('error', () => reject(new CliError(`The ${command} executable is not available.`, EXIT.filesystem, 'package_manager_unavailable')));
        child.once('exit', (code) => resolve(code ?? 1));
    });
}
async function commandAvailable(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false, stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
    });
}
async function commandCreate(args, json) {
    const name = args.shift();
    if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name))
        throw new CliError('Project name must use lowercase letters, numbers and internal hyphens.', EXIT.usage, 'invalid_project_name');
    const framework = (takeOption(args, '--template') ?? 'react');
    const packageManager = (takeOption(args, '--package-manager') ?? 'npm');
    const moduleValues = takeRepeatedOption(args, '--module');
    const database = takeOption(args, '--database');
    const noInstall = takeFlag(args, '--no-install');
    const explicitInstall = takeFlag(args, '--install');
    if (noInstall && explicitInstall)
        throw new CliError('Choose either --install or --no-install.', EXIT.usage, 'conflicting_options');
    const install = !noInstall;
    assertNoUnknown(args);
    if (!SUPPORTED_FRONTENDS.includes(framework))
        throw new CliError(`Unsupported template: ${framework}. Choose ${SUPPORTED_FRONTENDS.join(', ')}.`, EXIT.usage, 'invalid_template');
    if (!SUPPORTED_MANAGERS.includes(packageManager))
        throw new CliError(`Unsupported package manager: ${packageManager}.`, EXIT.usage, 'invalid_package_manager');
    if (database && !/^[A-Z][A-Z0-9_]{0,127}$/.test(database))
        throw new CliError('Database bindings use uppercase letters, numbers and underscores.', EXIT.usage, 'invalid_database');
    const modules = moduleValues.map(parseModule);
    if (new Set(modules.map((item) => item.name)).size !== modules.length)
        throw new CliError('Backend module names must be unique.', EXIT.usage, 'duplicate_module');
    const target = resolveLocalPath(name);
    const scaffold = createScaffold({ name, framework, packageManager, modules, ...(database ? { database } : {}) });
    await writeScaffoldAtomically(target, scaffold.files, scaffold.manifest);
    if (install && framework !== 'html') {
        const installArgs = {
            npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--no-progress'],
            pnpm: ['install', '--ignore-scripts', '--prefer-offline'],
            yarn: ['install', '--mode=skip-build'],
            bun: ['install', '--ignore-scripts', '--no-progress'],
        };
        const code = await runProcess(packageManager, installArgs[packageManager], target, json);
        if (code !== 0)
            throw new CliError(`Dependency installation exited with code ${code}. The project files were kept.`, EXIT.filesystem, 'install_failed');
    }
    const nextSteps = !install && framework !== 'html' ? [`cd ${name}`, `${packageManager} install`, 'blinkhost test .', 'blinkhost dev .'] : [`cd ${name}`, 'blinkhost test .', ...(framework === 'html' ? [] : ['blinkhost dev .'])];
    emit({ ok: true, command: 'create', message: `Created ${name} at ${target}.`, data: { path: target, framework, package_manager: packageManager, modules: modules.length, generated_files: [...scaffold.files.keys(), 'blinkhost.yaml'].sort(), installed: install && framework !== 'html', next_steps: nextSteps } }, json);
}
function commandSuggestion(command) {
    const distance = (left, right) => {
        const row = Array.from({ length: right.length + 1 }, (_, index) => index);
        for (let i = 1; i <= left.length; i += 1) {
            let previous = row[0];
            row[0] = i;
            for (let j = 1; j <= right.length; j += 1) {
                const before = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
                previous = before;
            }
        }
        return row[right.length];
    };
    const ranked = TOP_LEVEL_COMMANDS.map((candidate) => ({ candidate, distance: distance(command, candidate) })).sort((a, b) => a.distance - b.distance);
    return ranked[0] && ranked[0].distance <= Math.max(2, Math.floor(command.length / 3)) ? ranked[0].candidate : null;
}
async function commandInit(args, json) {
    const force = takeFlag(args, '--force');
    const dryRun = takeFlag(args, '--dry-run');
    const path = args.shift();
    assertNoUnknown(args);
    if (force && dryRun)
        throw new CliError('Choose either --force or --dry-run.', EXIT.usage, 'conflicting_options');
    const root = resolveLocalPath(path);
    const manifest = await detectManifest(root);
    if (dryRun) {
        emit({ ok: true, command: 'init', message: 'Detected a BlinkHost manifest without writing any files.', data: { path: root, framework: manifest.frontend.framework, written: false, manifest } }, json);
        return;
    }
    await writeManifest(root, manifest, force);
    emit({ ok: true, command: 'init', message: `Created blinkhost.yaml in ${root}.`, data: { path: root, framework: manifest.frontend.framework, written: true, changed_files: ['blinkhost.yaml'] } }, json);
}
async function commandValidate(args, json) {
    const path = args.shift();
    assertNoUnknown(args);
    const root = resolveLocalPath(path);
    const result = await validateProject(root);
    if (result.errors.length)
        throw new CliError('Project validation failed.', EXIT.validation, 'project_invalid', result.errors);
    emit({ ok: true, command: 'validate', message: `Project is compatible with ${result.manifest.schema}.`, data: { framework: result.manifest.frontend.framework, modules: result.manifest.modules.length, databases: result.manifest.resources.databases.length }, warnings: result.warnings }, json);
}
async function commandManifest(args, json) {
    const path = args.shift();
    assertNoUnknown(args);
    const manifest = await readProjectManifest(resolveLocalPath(path));
    if (json)
        emit({ ok: true, command: 'manifest', message: 'Manifest parsed.', data: manifest }, true);
    else
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
async function commandDoctor(args, json) {
    const path = args.shift();
    assertNoUnknown(args);
    const checks = [];
    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    const supportedNode = (nodeMajor ?? 0) > 22 || nodeMajor === 22 && (nodeMinor ?? 0) >= 12;
    checks.push({ name: 'node', ok: supportedNode, detail: process.versions.node });
    let gitOk = false;
    try {
        gitOk = await commandAvailable('git', ['--version']);
    }
    catch { }
    checks.push({ name: 'git', ok: gitOk, detail: gitOk ? 'available' : 'not found' });
    const root = resolveLocalPath(path);
    try {
        const validation = await validateProject(root);
        checks.push({ name: 'project', ok: validation.errors.length === 0, detail: validation.errors.join('; ') || 'manifest and declared paths are valid' });
    }
    catch (error) {
        checks.push({ name: 'project', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
        await access(root);
        checks.push({ name: 'directory', ok: true, detail: root });
    }
    catch {
        checks.push({ name: 'directory', ok: false, detail: 'not accessible' });
    }
    const failed = checks.filter((check) => !check.ok);
    if (failed.length)
        throw new CliError('One or more environment checks failed.', EXIT.validation, 'doctor_failed', failed.map((check) => `${check.name}: ${check.detail}`));
    emit({ ok: true, command: 'doctor', message: 'BlinkHost project environment is ready.', data: { checks } }, json);
}
export async function main(argv = process.argv.slice(2)) {
    const args = [...argv];
    const json = takeFlag(args, '--json');
    quietOutput = takeFlag(args, '--quiet');
    verboseOutput = takeFlag(args, '--verbose');
    takeFlag(args, '--no-color');
    const nonInteractive = takeFlag(args, '--non-interactive');
    const profile = takeOption(args, '--profile');
    const command = args.shift();
    try {
        const helpRequested = takeFlag(args, '--help');
        if (!command || command === '--help') {
            if (json)
                emit({ ok: true, command: 'help', message: 'BlinkHost CLI command index.', data: documentationIndex() }, true);
            else
                process.stdout.write(renderTopHelp());
            return EXIT.success;
        }
        if (command === '--version' || command === 'version') {
            if (json)
                emit({ ok: true, command: 'version', message: `BlinkHost CLI ${VERSION}.`, data: { version: VERSION } }, true);
            else
                process.stdout.write(`${VERSION}\n`);
            return EXIT.success;
        }
        if (command === 'help' || helpRequested) {
            const requested = command === 'help' ? args.shift() : command;
            assertNoUnknown(args);
            if (!requested) {
                if (json)
                    emit({ ok: true, command: 'help', message: 'BlinkHost CLI command index.', data: documentationIndex() }, true);
                else
                    process.stdout.write(renderTopHelp());
            }
            else {
                const topic = documentationTopic(requested);
                if (!topic)
                    throw new CliError(`No help is available for ${requested}. Run \`blinkhost docs\` to list topics.`, EXIT.usage, 'unknown_help_topic');
                if (json)
                    emit({ ok: true, command: `help ${requested}`, message: `${topic.title}.`, data: { schema: 'blinkhost/cli-docs/v1', cli_version: VERSION, topic } }, true);
                else
                    process.stdout.write(renderTopic(topic));
            }
            return EXIT.success;
        }
        if (command === 'docs') {
            const search = takeOption(args, '--search');
            const topicName = args.shift();
            assertNoUnknown(args);
            if (search && topicName)
                throw new CliError('Choose a documentation topic or --search, not both.', EXIT.usage, 'conflicting_options');
            if (search) {
                const results = searchDocumentation(search);
                if (json)
                    emit({ ok: true, command: 'docs search', message: `${results.length} documentation topic(s) matched.`, data: { schema: 'blinkhost/cli-docs/v1', cli_version: VERSION, query: search, results } }, true);
                else
                    process.stdout.write(results.length ? results.map(renderTopic).join('\n') : `No offline documentation matched “${terminalText(search)}”.\n`);
            }
            else if (topicName) {
                const topic = documentationTopic(topicName);
                if (!topic)
                    throw new CliError(`Unknown documentation topic: ${topicName}. Run \`blinkhost docs\` to list topics.`, EXIT.usage, 'unknown_docs_topic');
                if (json)
                    emit({ ok: true, command: `docs ${topicName}`, message: `${topic.title}.`, data: { schema: 'blinkhost/cli-docs/v1', cli_version: VERSION, topic } }, true);
                else
                    process.stdout.write(renderTopic(topic));
            }
            else if (json)
                emit({ ok: true, command: 'docs', message: 'Offline documentation index.', data: documentationIndex() }, true);
            else
                process.stdout.write(renderTopHelp());
            return EXIT.success;
        }
        if (command === 'quickstart') {
            const path = args.shift();
            assertNoUnknown(args);
            const data = await quickstart(path);
            emit({ ok: true, command, message: 'Local BlinkHost readiness check completed. No remote changes were made.', data }, json);
            return EXIT.success;
        }
        if (!supportedNodeVersion())
            throw new CliError(`Node.js ${process.versions.node} is unsupported. Install Node.js 22.12 or newer. Help, docs and quickstart remain available.`, EXIT.filesystem, 'unsupported_node');
        if (profile)
            validateProfileName(profile);
        if (command === 'create')
            await commandCreate(args, json);
        else if (command === 'init')
            await commandInit(args, json);
        else if (command === 'validate')
            await commandValidate(args, json);
        else if (command === 'manifest')
            await commandManifest(args, json);
        else if (command === 'doctor')
            await commandDoctor(args, json);
        else if (command === 'test') {
            const data = await testProject(args, json);
            emit({ ok: true, command, message: 'Project checks passed.', data }, json);
        }
        else if (command === 'auth') {
            const action = args.shift() || 'status';
            if (action === 'login') {
                const apiOrigin = takeOption(args, '--api-origin');
                const noBrowser = takeFlag(args, '--no-browser');
                assertNoUnknown(args);
                if (nonInteractive)
                    throw new CliError('Interactive account authorization is disabled. Use an approved workload identity in automation.', EXIT.auth, 'interaction_required');
                const data = await login({ ...(profile ? { profile } : {}), ...(apiOrigin ? { apiOrigin } : {}), openBrowser: !noBrowser, ...(!json && !quietOutput ? { progress: (line) => { process.stderr.write(`${terminalText(line)}\n`); } } : {}) });
                emit({ ok: true, command: 'auth login', message: 'This device is connected to BlinkHost.', data }, json);
            }
            else if (action === 'logout') {
                assertNoUnknown(args);
                const data = await logout(profile);
                emit({ ok: true, command: 'auth logout', message: `Signed out CLI profile ${data.profile}.`, data }, json);
            }
            else if (action === 'status') {
                assertNoUnknown(args);
                const client = await ApiClient.create(profile);
                const data = await client.request('/api/cli/v2/capabilities/');
                emit({ ok: true, command: 'auth status', message: 'The CLI session is active.', data }, json);
            }
            else if (action === 'sessions') {
                assertNoUnknown(args);
                const client = await ApiClient.create(profile);
                const data = await client.request('/api/cli/v2/sessions/');
                emit({ ok: true, command: 'auth sessions', message: 'CLI sessions loaded.', data }, json);
            }
            else if (action === 'revoke') {
                const id = args.shift();
                assertNoUnknown(args);
                if (!id || !/^[0-9a-f-]{36}$/i.test(id))
                    throw new CliError('Provide a valid CLI session ID.', EXIT.usage, 'invalid_session_id');
                const client = await ApiClient.create(profile);
                await client.request(`/api/cli/v2/sessions/${id}/`, { method: 'DELETE' });
                emit({ ok: true, command: 'auth revoke', message: 'CLI session revoked.', data: { id } }, json);
            }
            else
                throw new CliError(`Unknown auth action: ${action}.`, EXIT.usage, 'unknown_action');
        }
        else if (command === 'profile') {
            const action = args.shift() || 'list';
            const config = await readConfig();
            if (action === 'list') {
                assertNoUnknown(args);
                emit({ ok: true, command: 'profile list', message: `Active profile: ${config.activeProfile}.`, data: { active: config.activeProfile, profiles: config.profiles } }, json);
            }
            else if (action === 'use') {
                const name = validateProfileName(args.shift() || '');
                assertNoUnknown(args);
                if (!config.profiles[name])
                    throw new CliError('Profile not found. Sign in with that profile first.', EXIT.usage, 'profile_not_found');
                config.activeProfile = name;
                await writeConfig(config);
                emit({ ok: true, command: 'profile use', message: `Using profile ${name}.`, data: { active: name } }, json);
            }
            else
                throw new CliError(`Unknown profile action: ${action}.`, EXIT.usage, 'unknown_action');
        }
        else if (command === 'projects' && args[0] === 'link') {
            args.shift();
            const projectId = args.shift();
            const root = args.shift();
            assertNoUnknown(args);
            if (!projectId)
                throw new CliError('Provide a project ID.', EXIT.usage, 'project_required');
            const selected = await activeProfile(profile);
            const data = await writeProjectLink(projectId, selected.name, root);
            emit({ ok: true, command: 'projects link', message: 'This directory is linked to the BlinkHost project.', data }, json);
        }
        else if (command === 'projects' && args[0] === 'current') {
            args.shift();
            const root = args.shift();
            assertNoUnknown(args);
            const data = await readProjectLink(root);
            emit({ ok: true, command: 'projects current', message: `Linked project: ${data.project_id}.`, data }, json);
        }
        else if (command === 'projects' && args[0] === 'unlink') {
            args.shift();
            const root = args.shift();
            assertNoUnknown(args);
            const data = await unlinkProject(root);
            emit({ ok: true, command: 'projects unlink', message: 'Removed the local BlinkHost project link. The remote project was not changed.', data }, json);
        }
        else if (command === 'projects' && args[0] === 'status') {
            args.shift();
            assertNoUnknown(args);
            const data = await projectStatus(profile);
            emit({ ok: true, command: 'projects status', message: 'Project and source connection status loaded.', data }, json);
        }
        else if (command === 'projects' && (args[0] === 'pull' || args[0] === 'push')) {
            const action = args.shift();
            const data = await syncProject(action, args, profile);
            emit({ ok: true, command: `projects ${action}`, message: `${action === 'pull' ? 'Pulled repository changes into BlinkHost.' : 'Pushed BlinkHost changes to the connected repository.'}`, data }, json);
        }
        else if (command === 'previews' && args[0] === 'open') {
            args.shift();
            const data = await openPreview(args, profile, !nonInteractive);
            emit({ ok: true, command: 'previews open', message: nonInteractive ? 'Preview URL loaded without opening a browser.' : 'Opened the preview in your browser.', data }, json);
        }
        else if ((command === 'builds' || command === 'deployments' || command === 'previews') && args[0] === 'wait') {
            args.shift();
            const data = await waitForRemote(command, args, profile);
            emit({ ok: true, command: `${command} wait`, message: `${command.slice(0, -1)} is ready.`, data }, json);
        }
        else if (command === 'assets' && args[0] === 'upload') {
            args.shift();
            const data = await uploadAsset(args, profile);
            emit({ ok: true, command: 'assets upload', message: 'Asset uploaded and verified.', data }, json);
        }
        else if (['projects', 'repositories', 'connections', 'previews', 'builds', 'deployments', 'modules', 'databases', 'bindings', 'assets', 'organizations', 'templates', 'approvals', 'handoffs', 'policies', 'workloads'].includes(command)) {
            const data = await runRemote(command, args, profile);
            emit({ ok: true, command, message: `${command[0]?.toUpperCase()}${command.slice(1)} request completed.`, data }, json);
        }
        else if (command === 'secrets') {
            const data = await runSecrets(args, profile);
            emit({ ok: true, command, message: 'Secret operation completed.', data }, json);
        }
        else if (command === 'dev') {
            const data = await runDev(args, json);
            emit({ ok: true, command, message: 'Local development process finished.', data }, json);
        }
        else if (command === 'logs' || command === 'metrics' || command === 'analytics') {
            const data = await observability(command, args, profile);
            emit({ ok: true, command, message: `${command} loaded.`, data }, json);
        }
        else if (command === 'support' && args.shift() === 'bundle') {
            const data = await supportBundle(args, profile);
            emit({ ok: true, command: 'support bundle', message: `Created redacted support bundle at ${data.output}.`, data }, json);
        }
        else if (command === 'completion') {
            const output = completion(args.shift());
            assertNoUnknown(args);
            if (json)
                emit({ ok: true, command, message: 'Shell completion generated.', data: { script: output } }, true);
            else
                process.stdout.write(output);
        }
        else if (command === 'update' && args.shift() === 'check') {
            assertNoUnknown(args);
            const data = await checkForUpdate();
            emit({ ok: true, command: 'update check', message: 'Release check completed.', data }, json);
        }
        else if (command === 'ci' && args.shift() === 'check') {
            assertNoUnknown(args);
            const data = await ciCheck(profile);
            emit({ ok: true, command: 'ci check', message: 'CI identity and API capabilities are ready.', data }, json);
        }
        else if (command === 'plugins') {
            const data = await runPlugins(args, json);
            emit({ ok: true, command, message: 'Plugin operation completed.', data }, json);
        }
        else if (command === 'api') {
            const data = await rawApi(args, profile);
            emit({ ok: true, command, message: 'API request completed.', data }, json);
        }
        else {
            const suggestion = commandSuggestion(command);
            throw new CliError(`Unknown command: ${command}.${suggestion ? ` Did you mean \`${suggestion}\`?` : ' Run `blinkhost docs` to list commands.'}`, EXIT.usage, 'unknown_command');
        }
        return EXIT.success;
    }
    catch (error) {
        const failure = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error), EXIT.internal, 'internal_error');
        if (json)
            process.stdout.write(`${JSON.stringify({ ok: false, command: command ?? '', error: { code: failure.code, message: failure.message, details: failure.details } })}\n`);
        else {
            process.stderr.write(`Error: ${terminalText(failure.message)}\n`);
            for (const detail of failure.details)
                process.stderr.write(`  - ${terminalText(detail)}\n`);
            if (verboseOutput)
                process.stderr.write(`Code: ${failure.code}; exit: ${failure.exitCode}\n`);
        }
        return failure.exitCode;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = await main();
}
//# sourceMappingURL=cli.js.map