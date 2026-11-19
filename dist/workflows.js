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
import { runLocalDev } from './local-dev.js';
import { parseLogOptions, sinceFilters } from './logs.js';
import { LOCAL_TEST_LIMITS, LocalTestChecksFailure, LocalTestCommandFailure, runLocalTestCommand } from './local-test-command.js';
import { discoverLocalProjects, readLocalTestConfig } from './local-test-config.js';
import { captureLocalTestGateConfiguration, prepareLocalTestGate, finishLocalTestGate, blockedLocalTestGate } from './local-test-gates.js';
import { createLocalTestResultSink, readLocalTestResults, removeLocalTestResultSink, screenLocalTestRunContext, LOCAL_TEST_RESULT_LIMITS } from './local-test-results.js';
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
async function spawnInherited(command, args, cwd, env, json = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: env || process.env, shell: false, stdio: json ? ['inherit', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
        if (json) {
            child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
            child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        }
        const forward = (signal) => child.kill(signal);
        process.once('SIGINT', forward);
        process.once('SIGTERM', forward);
        child.once('error', () => reject(new CliError(`The ${command} executable is unavailable.`, EXIT.filesystem, 'executable_unavailable')));
        child.once('exit', (code) => { process.off('SIGINT', forward); process.off('SIGTERM', forward); resolve(code ?? 1); });
    });
}
export async function runDev(input, json = false, write) {
    const args = [...input];
    const localConfig = takeOption(args, '--local-config');
    const stateDirectory = takeOption(args, '--state-dir');
    const localBuildConfig = takeOption(args, '--local-build-config');
    const watchArtifact = takeFlag(args, '--watch-artifact');
    const watchSource = takeFlag(args, '--watch-source');
    const host = takeOption(args, '--host');
    const port = takeOption(args, '--port');
    const root = resolveLocalPath(args.shift());
    noExtra(args);
    if ((localConfig === undefined) !== (stateDirectory === undefined)) {
        throw new CliError('Local stack development requires both --local-config FILE and --state-dir NEW_DIRECTORY.', EXIT.usage, 'local_stack_options_required');
    }
    if (watchArtifact && localConfig === undefined) {
        throw new CliError('Artifact watching requires --local-config FILE and --state-dir NEW_DIRECTORY.', EXIT.usage, 'local_stack_watch_options_required');
    }
    if (localBuildConfig !== undefined && localConfig === undefined) {
        throw new CliError('Local source builds require --local-config FILE and --state-dir NEW_DIRECTORY.', EXIT.usage, 'local_source_build_options_required');
    }
    if (localBuildConfig !== undefined && watchArtifact) {
        throw new CliError('Use source compilation or separately compiled artifact watching in a development run.', EXIT.usage, 'local_source_build_watch_conflict');
    }
    if (watchSource && (localBuildConfig === undefined || watchArtifact)) {
        throw new CliError('Source watching requires --local-build-config FILE and the explicit local stack.', EXIT.usage, 'local_source_watch_options_required');
    }
    if (localConfig !== undefined && (host !== undefined || port !== undefined)) {
        throw new CliError('Local stack listeners use loopback ports selected by the operating system. Omit --host and --port.', EXIT.usage, 'local_stack_listen_options');
    }
    const validation = await validateProject(root);
    if (validation.errors.length)
        throw new CliError('Project validation failed before local development started.', EXIT.validation, 'project_invalid', validation.errors);
    const manifest = validation.manifest;
    if (localConfig !== undefined && stateDirectory !== undefined)
        return runLocalDev(root, localConfig, stateDirectory, json, write, watchArtifact, localBuildConfig, watchSource);
    if (manifest.frontend.framework === 'html')
        throw new CliError('Static HTML projects do not define a development process. Use a local static-file server.', EXIT.validation, 'dev_command_unavailable');
    const manager = manifest.frontend.package_manager;
    const managerArgs = manager === 'npm' ? ['run', 'dev', '--'] : ['run', 'dev'];
    if (host)
        managerArgs.push('--host', host);
    if (port)
        managerArgs.push('--port', port);
    const dependencyRoot = manifest.frontend.dependency_root === '.' ? root : join(root, manifest.frontend.dependency_root);
    const exitCode = await spawnInherited(manager, managerArgs, dependencyRoot, { ...process.env, BLINKHOST_LOCAL: '1' }, json);
    if (exitCode !== 0)
        throw new CliError(`The local development process exited with code ${exitCode}.`, EXIT.remote, 'dev_process_failed', [`If dependencies are missing, run \`${manager} install\` in ${dependencyRoot}, then retry.`]);
    return { exit_code: exitCode };
}
export function localProjectCheckMessage(result) {
    const message = result.test_counts
        ? `Customer runner reported ${result.test_counts.passed} passed, ${result.test_counts.failed} failed, ${result.test_counts.skipped} skipped and ${result.test_counts.unsupported} unsupported tests.`
        : result.test_evidence === 'mixed'
            ? 'Configured local commands completed. Some results are customer runner reported; aggregate test counts are unknown.'
            : result.status === 'validation_only'
                ? 'Project structure validated. No tests ran.'
                : result.status === 'build_only'
                    ? result.configuration === 'frontend_default' ? 'Frontend build completed. No tests ran.' : 'Local build commands completed. No tests ran.'
                    : result.status === 'checks_succeeded'
                        ? 'Configured local commands completed. Test counts and coverage were not collected.'
                        : 'Frontend test command completed. Test counts and coverage were not collected.';
    const untested = result.backend_modules.filter(row => ['not_run', 'build_only', 'no_tests', 'skipped', 'unsupported'].includes(row.status)).length;
    return message + (untested ? ` ${untested} backend module(s) were not tested.` : '')
        + (result.discovery.nested_projects.length ? ` ${result.discovery.nested_projects.length} nested project(s) were not run; test them explicitly.` : '')
        + (!result.discovery.complete ? ' Project discovery reached a bound; review the remaining directories explicitly.' : '')
        + (result.local_gate ? ` The ${result.local_gate.stage} local gate ${result.local_gate.status} for the declared inputs.` : '');
}
export async function testProject(input, _json = false, signal) {
    const args = [...input];
    const timeoutRaw = takeOption(args, '--timeout');
    const outputRaw = takeOption(args, '--max-output-bytes');
    const gateStage = takeOption(args, '--gate');
    const numeric = (value, fallback, maximum, minimum) => {
        if (value === undefined)
            return fallback;
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
            throw new CliError('Test timeout must be 1–3600 seconds; output limit must be 1024–8388608 bytes.', EXIT.usage, 'invalid_test_limits');
        }
        return number;
    };
    const timeoutMs = numeric(timeoutRaw, LOCAL_TEST_LIMITS.timeoutMs / 1000, LOCAL_TEST_LIMITS.maxTimeoutMs / 1000, 1) * 1000;
    const maxOutputBytes = numeric(outputRaw, LOCAL_TEST_LIMITS.maxOutputBytes, LOCAL_TEST_LIMITS.maximumOutputBytes, 1024);
    const gateDeadline = performance.now() + timeoutMs;
    const root = resolveLocalPath(args.shift());
    noExtra(args);
    let gateConfiguration;
    if (gateStage !== undefined) {
        if (gateStage !== 'preview' && gateStage !== 'promotion')
            throw new CliError('Select preview or promotion for the local test gate.', EXIT.validation, 'invalid_local_test_gate');
        try {
            gateConfiguration = await captureLocalTestGateConfiguration(root, gateDeadline, signal);
        }
        catch (error) {
            if (error instanceof CliError)
                throw error;
            throw new CliError('Local test gates require available project, test and gate configuration files.', EXIT.validation, 'invalid_local_test_gate');
        }
    }
    const validation = await validateProject(root);
    if (validation.errors.length)
        throw new CliError('Project validation failed.', EXIT.validation, 'project_invalid', validation.errors);
    const manifest = validation.manifest;
    const configured = await readLocalTestConfig(root, manifest);
    if (gateStage !== undefined && !configured)
        throw new CliError('Local test gates require explicit structured customer checks.', EXIT.validation, 'invalid_local_test_gate');
    const discovery = await discoverLocalProjects(root, signal);
    const common = {
        schema: 'blinkhost.local-project-checks/v1',
        validated: true,
        coverage: { native: 'not_collected', wasm: 'not_collected' },
        backend_modules: manifest.modules.map(({ name, path, language }) => ({ name, path, language,
            status: 'not_run' })),
        discovery,
    };
    if (!configured && manifest.frontend.framework === 'html')
        return {
            ...common, status: 'validation_only', build: 'not_required', tests_executed: 0, test_evidence: 'not_run',
            configuration: 'none', checks: [],
        };
    let definitions = configured;
    if (!definitions) {
        const packageJson = JSON.parse(await readFile(join(root, manifest.frontend.dependency_root, 'package.json'), 'utf8'));
        const script = packageJson.scripts?.test ? 'test' : 'build';
        definitions = [{ id: 'frontend', target: 'frontend', cwd: manifest.frontend.dependency_root,
                command: manifest.frontend.package_manager, args: ['run', script], kind: script, profile: 'unspecified' }];
    }
    const configuration = configured ? 'explicit' : 'frontend_default';
    const checks = definitions.map(({ command: _command, args: _args, ...row }) => ({ ...row, status: 'not_run' }));
    const deadline = gateStage !== undefined ? gateDeadline : performance.now() + timeoutMs;
    let gate;
    try {
        gate = gateStage !== undefined ? await prepareLocalTestGate(root, gateStage, definitions, { timeout_ms: timeoutMs, max_output_bytes: maxOutputBytes }, deadline, signal, gateConfiguration) : undefined;
    }
    catch (error) {
        if (error instanceof CliError)
            throw error;
        throw new CliError('Local test gate inputs are missing or unavailable.', EXIT.validation, 'invalid_local_test_gate');
    }
    const failureContext = (reason) => ({ configuration, checks, backend_modules: common.backend_modules, discovery,
        ...(gate ? { local_gate: blockedLocalTestGate(gate, checks, reason) } : {}) });
    let outputRemaining = maxOutputBytes;
    let resultBytesRemaining = LOCAL_TEST_RESULT_LIMITS.totalBytes;
    for (let index = 0; index < checks.length; index++) {
        const check = checks[index];
        const definition = definitions[index];
        if (signal?.aborted || performance.now() >= deadline || outputRemaining < 1) {
            throw new LocalTestChecksFailure(signal?.aborted ? 'Project checks were cancelled.'
                : outputRemaining < 1 ? 'Project checks exhausted their shared output budget.' : 'Project checks exhausted their shared timeout.', signal?.aborted ? signal.reason === 'SIGTERM' ? 143 : 130 : EXIT.validation, signal?.aborted ? 'project_test_cancelled' : outputRemaining < 1 ? 'project_test_output_limit' : 'project_test_timeout', [], failureContext('test_execution_incomplete'));
        }
        const sink = definition.results ? await createLocalTestResultSink() : undefined;
        let execution;
        try {
            const env = { ...process.env, CI: '1' };
            // A parent node:test harness sets this private marker. Inheriting it silently
            // suppresses a new customer runner's file execution and custom reporters.
            delete env.NODE_TEST_CONTEXT;
            delete env.BLINKHOST_TEST_RESULT_PATH;
            delete env.BLINKHOST_TEST_RUN_ID;
            delete env.BLINKHOST_TEST_CHECK_ID;
            delete env.BLINKHOST_TEST_PROFILE;
            if (sink)
                Object.assign(env, { BLINKHOST_TEST_RESULT_PATH: sink.path, BLINKHOST_TEST_RUN_ID: sink.runId,
                    BLINKHOST_TEST_CHECK_ID: check.id, BLINKHOST_TEST_PROFILE: check.profile });
            execution = await runLocalTestCommand(definition.command, definition.args, {
                cwd: join(root, check.cwd), env,
                timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), maxOutputBytes: outputRemaining,
                ...(signal ? { signal } : {}),
            });
            if (sink) {
                execution.output.stdout = screenLocalTestRunContext(execution.output.stdout, sink);
                execution.output.stderr = screenLocalTestRunContext(execution.output.stderr, sink);
            }
            check.status = execution.status;
            check.execution = execution;
            if (sink && (execution.status === 'succeeded' || execution.status === 'failed')) {
                try {
                    check.report = await readLocalTestResults(sink, check, resultBytesRemaining);
                }
                catch (error) {
                    check.report_error = error instanceof CliError ? error.code : 'invalid_local_test_results';
                }
                if (check.report) {
                    resultBytesRemaining -= check.report.source_bytes;
                    if (check.report.coverage.status === 'collected' && (check.profile === 'native' || check.profile === 'wasm')) {
                        common.coverage[check.profile] = 'customer_runner_reported';
                    }
                }
            }
        }
        finally {
            if (sink)
                await removeLocalTestResultSink(sink);
        }
        outputRemaining -= execution.captured_output_bytes;
        const module = common.backend_modules.find(row => check.target === `module:${row.name}`);
        if (module) {
            if (execution.status !== 'succeeded' || check.report_error || check.report?.status === 'failed')
                module.status = 'failed';
            else if (check.kind === 'build') {
                if (module.status === 'not_run')
                    module.status = 'build_only';
            }
            else if (check.report?.status === 'passed')
                module.status = 'tests_passed';
            else if (!['tests_passed', 'test_command_succeeded'].includes(module.status))
                module.status = check.report?.status ?? 'test_command_succeeded';
        }
        const context = failureContext('test_execution_failed');
        if (execution.status === 'succeeded' && (signal?.aborted || performance.now() >= deadline)) {
            throw new LocalTestChecksFailure(signal?.aborted ? 'Project checks were cancelled.' : 'Project checks exhausted their shared timeout.', signal?.aborted ? signal.reason === 'SIGTERM' ? 143 : 130 : EXIT.validation, signal?.aborted ? 'project_test_cancelled' : 'project_test_timeout', [], context);
        }
        if (execution.status === 'succeeded' && (check.report_error || check.report?.status === 'failed')) {
            throw new LocalTestChecksFailure(check.report_error ? 'The required customer runner result is missing or invalid.' : 'The customer runner reported failed tests.', EXIT.validation, check.report_error ?? 'project_test_results_failed', [], context);
        }
        if (execution.status === 'succeeded')
            continue;
        const failures = {
            failed: [`Project ${check.kind} exited with code ${execution.exit_code ?? execution.signal ?? 'unknown'}.`, EXIT.validation, 'project_test_failed'],
            timed_out: [`Project ${check.kind} exceeded its shared timeout.`, EXIT.validation, 'project_test_timeout'],
            output_limit: [`Project ${check.kind} exceeded its shared output limit.`, EXIT.validation, 'project_test_output_limit'],
            cancelled: [`Project ${check.kind} was cancelled.`, signal?.reason === 'SIGTERM' ? 143 : 130, 'project_test_cancelled'],
            unavailable: ['The local check executable is unavailable.', EXIT.filesystem, 'executable_unavailable'],
        };
        const [message, exitCode, code] = failures[execution.status];
        throw new LocalTestCommandFailure(message, exitCode, code, execution, ['Local command cleanup covers the owned POSIX process group, or the direct child on Windows. This is not a security sandbox.'], context);
    }
    const hasTests = checks.some(row => row.kind !== 'build');
    const testChecks = checks.filter(row => row.kind !== 'build');
    const reportedChecks = testChecks.filter(row => row.report);
    const allReported = hasTests && reportedChecks.length === testChecks.length;
    const testCounts = allReported ? reportedChecks.reduce((sum, row) => {
        for (const key of ['total', 'passed', 'failed', 'skipped', 'unsupported'])
            sum[key] += row.report.counts[key];
        return sum;
    }, { total: 0, passed: 0, failed: 0, skipped: 0, unsupported: 0 }) : undefined;
    const first = checks[0];
    const localGate = gate ? await finishLocalTestGate(gate, checks, deadline, signal) : undefined;
    if (localGate?.status === 'blocked')
        throw new LocalTestChecksFailure('The selected local test gate did not pass.', localGate.reason === 'project_test_cancelled' ? signal?.reason === 'SIGTERM' ? 143 : 130 : EXIT.validation, localGate.reason === 'project_test_cancelled' || localGate.reason === 'project_test_timeout' ? localGate.reason : 'local_test_gate_blocked', [], { ...failureContext(localGate.reason ?? 'required_checks_blocked'), local_gate: localGate });
    return { ...common, configuration, checks,
        status: testCounts ? testCounts.passed ? 'tests_passed' : !testCounts.total ? 'no_tests'
            : testCounts.unsupported === testCounts.total ? 'unsupported' : 'skipped'
            : hasTests ? configured ? 'checks_succeeded' : 'test_command_succeeded' : 'build_only',
        ...(!configured ? { command: [definitions[0].command, ...definitions[0].args].join(' '), execution: first.execution } : {}),
        exit_code: 0, tests_executed: testCounts ? testCounts.passed + testCounts.failed : hasTests ? null : 0,
        test_evidence: allReported ? 'customer_runner_reported' : reportedChecks.length ? 'mixed' : hasTests ? 'command_exit_only' : 'not_run',
        ...(testCounts ? { test_counts: testCounts } : {}), ...(localGate ? { local_gate: localGate } : {}) };
}
export async function observability(kind, input, profile) {
    if (kind === 'logs') {
        const options = parseLogOptions(input);
        if (options.follow)
            throw new CliError('Use the streaming logs command for --follow.', EXIT.usage, 'invalid_log_options');
        const project = options.project || (await readProjectLink()).project_id;
        const query = new URLSearchParams(options.filters);
        if (options.cursor)
            query.set('cursor', options.cursor);
        return (await ApiClient.create(profile)).request(`/api/sites/${encodeURIComponent(project)}/observability/logs/?${query}`, {}, 2 * 1024 * 1024);
    }
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
        for (const [key, value] of Object.entries(sinceFilters(since, Date.now(), true)))
            query.set(key, value);
    if (limit) {
        if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)
            throw new CliError('--limit must be an integer from 1 to 200.', EXIT.usage, 'invalid_log_options');
        query.set('limit', limit);
    }
    const suffix = query.size ? `?${query}` : '';
    const client = await ApiClient.create(profile);
    return client.request(`/api/sites/${encodeURIComponent(project)}/observability/${kind}/${suffix}`);
}
async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
export async function runPlugins(input, json = false) {
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
        const code = await spawnInherited(plugin.executable, passthrough, process.cwd(), env, json);
        if (code !== 0)
            throw new CliError(`Plugin ${name} exited with code ${code}.`, EXIT.remote, 'plugin_failed');
        return { name, exit_code: code };
    }
    throw new CliError(`Unknown plugins action: ${action}.`, EXIT.usage, 'unknown_action');
}
const commandWords = TOP_LEVEL_COMMANDS.join(' ');
const powershellCommands = TOP_LEVEL_COMMANDS.map((command) => `'${command}'`).join(',');
const COMPLETIONS = {
    bash: `complete -W "${commandWords}" blinkhost`,
    zsh: `#compdef blinkhost\n_arguments '1:command:(${commandWords})'`,
    fish: `complete -c blinkhost -f -a "${commandWords}"`,
    powershell: `Register-ArgumentCompleter -Native -CommandName blinkhost -ScriptBlock { param($wordToComplete) ${powershellCommands} | Where-Object { $_ -like "$wordToComplete*" } }`,
};
export function completion(shell) { if (!shell || !COMPLETIONS[shell])
    throw new CliError('Choose bash, zsh, fish, or powershell.', EXIT.usage, 'invalid_shell'); return `${COMPLETIONS[shell]}\n`; }
function versionTuple(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function newerThan(candidate, current) {
    const left = versionTuple(candidate);
    const right = versionTuple(current);
    if (!left || !right)
        return false;
    for (let index = 0; index < 3; index += 1) {
        const candidatePart = left[index] ?? 0;
        const currentPart = right[index] ?? 0;
        if (candidatePart !== currentPart)
            return candidatePart > currentPart;
    }
    return false;
}
async function releaseRequest(path, profile, timeoutMs = 3000) {
    const selected = await activeProfile(profile);
    return fetch(`${selected.profile.apiOrigin}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': `BlinkHost-CLI/${VERSION}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
    });
}
export async function checkForUpdate(profile, timeoutMs = 3000) {
    const query = new URLSearchParams({ component: 'cli', channel: 'stable', current_version: VERSION });
    const response = await releaseRequest(`/api/documentation/releases/latest/?${query}`, profile, timeoutMs);
    if (!response.ok)
        throw new CliError('The release service could not be reached.', EXIT.network, 'update_check_failed');
    const data = await response.json();
    return { ...data, current_version: VERSION, automatic_install: false };
}
export async function releaseNotes(version, profile) {
    const query = new URLSearchParams({ component: 'cli', channel: 'stable' });
    const response = await releaseRequest(`/api/documentation/releases/?${query}`, profile);
    if (!response.ok)
        throw new CliError('Release notes could not be loaded.', EXIT.network, 'release_notes_failed');
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : (payload.results || []);
    const releases = rows.filter((item) => Boolean(item && typeof item === 'object'));
    if (version) {
        const selected = releases.find((item) => item.version === version);
        if (!selected)
            throw new CliError(`No published CLI release notes were found for ${version}.`, EXIT.remote, 'release_not_found');
        return selected;
    }
    return { component: 'cli', releases };
}
export async function maybeUpdateNotice(profile) {
    if (!process.stderr.isTTY || process.env.CI || process.env.BLINKHOST_NO_UPDATE_NOTIFIER === '1')
        return null;
    const selected = await activeProfile(profile);
    if (selected.config.updateNotifications === false)
        return null;
    const checkedAt = selected.config.updateCheckedAt ? Date.parse(selected.config.updateCheckedAt) : 0;
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < 48 * 60 * 60 * 1000)
        return null;
    try {
        const result = await checkForUpdate(profile, 500);
        selected.config.updateCheckedAt = new Date().toISOString();
        if (result.latest_version)
            selected.config.latestVersion = result.latest_version;
        else
            delete selected.config.latestVersion;
        if (result.release_url)
            selected.config.latestReleaseUrl = result.release_url;
        else
            delete selected.config.latestReleaseUrl;
        await writeConfig(selected.config);
        if (!result.latest_version || !newerThan(result.latest_version, VERSION))
            return null;
        const instruction = result.install_command || `npm install --global @blinkhost/cli@${result.latest_version}`;
        return `BlinkHost CLI ${result.latest_version} is available. Run ${instruction} or \`blinkhost update notes ${result.latest_version}\`.`;
    }
    catch {
        return null;
    }
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
    const payload = { schema: 'blinkhost/support-bundle/v1', created_at: new Date().toISOString(), cli_version: VERSION, system: { platform: platform(), release: release(), node: process.versions.node, device_hash: createHash('sha256').update(hostname()).digest('hex').slice(0, 16) }, project, api };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { output, redacted: true };
}
//# sourceMappingURL=workflows.js.map