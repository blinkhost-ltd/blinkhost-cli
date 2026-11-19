import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { CliError, EXIT } from './errors.js';
import { LOCAL_TEST_CONFIG } from './local-test-config.js';
export const LOCAL_TEST_GATE_CONFIG = 'blinkhost.gates.json';
export const LOCAL_TEST_GATE_LIMITS = { files: 1024, bytes: 512 * 1024 * 1024, fileBytes: 256 * 1024 * 1024 };
const CATEGORIES = ['source', 'artifacts', 'dependencies', 'runtime', 'resources', 'fixtures'];
const CONFIGURATION = ['blinkhost.yaml', LOCAL_TEST_CONFIG, LOCAL_TEST_GATE_CONFIG];
const hash = (value) => createHash('sha256').update(value).digest('hex');
function invalid() { throw new CliError('Invalid local test gate configuration or inputs.', EXIT.validation, 'invalid_local_test_gate'); }
function budget(deadline, signal) {
    if (signal?.aborted)
        throw new CliError('Local test gate was cancelled.', signal.reason === 'SIGTERM' ? 143 : 130, 'project_test_cancelled');
    if (performance.now() >= deadline)
        throw new CliError('Local test gate exhausted the shared test timeout.', EXIT.validation, 'project_test_timeout');
}
function object(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
        invalid();
    return value;
}
async function read(filename, maximum, collect, deadline, signal) {
    budget(deadline, signal);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(maximum))
            invalid();
        const digest = createHash('sha256'), buffer = Buffer.alloc(65_536), chunks = [];
        let bytes = 0;
        while (true) {
            budget(deadline, signal);
            const result = await file.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), bytes);
            if (!result.bytesRead)
                break;
            bytes += result.bytesRead;
            if (bytes > maximum)
                invalid();
            const chunk = buffer.subarray(0, result.bytesRead);
            digest.update(chunk);
            if (collect)
                chunks.push(Buffer.from(chunk));
        }
        const after = await file.stat({ bigint: true }), current = await lstat(filename, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]
            || before[key] !== current[key]) || bytes !== Number(before.size))
            invalid();
        return { sha256: digest.digest('hex'), bytes, content: Buffer.concat(chunks) };
    }
    finally {
        await file.close();
    }
}
async function projectFile(root, path) {
    if (!path || path.length > 1024 || !/^[a-zA-Z0-9_.@/-]+$/.test(path)
        || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))
        invalid();
    let cursor = root;
    for (const part of path.split('/').slice(0, -1)) {
        cursor = join(cursor, part);
        const stat = await lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            invalid();
    }
    return join(root, path);
}
async function executable(command, cwd) {
    const candidates = command.includes('/') ? [isAbsolute(command) ? command : resolve(cwd, command)]
        : (process.env.PATH ?? '').split(delimiter).map(path => resolve(cwd, path || '.', command));
    for (const path of candidates) {
        try {
            await access(path, constants.X_OK);
            const filename = await realpath(path);
            if (!(await lstat(filename)).isFile())
                continue;
            return filename;
        }
        catch (error) {
            if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code ?? ''))
                throw error;
        }
    }
    invalid();
}
async function snapshot(prepared, deadline, signal) {
    budget(deadline, signal);
    if (await realpath(prepared.root) !== prepared.root)
        invalid();
    for (const tool of prepared.executables ?? []) {
        budget(deadline, signal);
        if (await executable(tool.command, tool.cwd) !== tool.filename)
            invalid();
    }
    let remaining = LOCAL_TEST_GATE_LIMITS.bytes;
    const inputs = [];
    for (const input of prepared.paths) {
        if (input.category !== 'cli' && await projectFile(prepared.root, input.path) !== input.filename)
            invalid();
        const value = await read(input.filename, Math.min(remaining, LOCAL_TEST_GATE_LIMITS.fileBytes), false, deadline, signal);
        if (input.category !== 'cli')
            await projectFile(prepared.root, input.path);
        remaining -= value.bytes;
        inputs.push({ category: input.category, path: input.path, sha256: value.sha256, bytes: value.bytes });
    }
    budget(deadline, signal);
    return inputs;
}
/** Bind configuration observed before validation to configuration used for execution. */
export async function captureLocalTestGateConfiguration(root, deadline, signal) {
    root = await realpath(root);
    const inputs = [];
    for (const path of CONFIGURATION) {
        const value = await read(await projectFile(root, path), 65_536, false, deadline, signal);
        inputs.push({ category: 'configuration', path, sha256: value.sha256, bytes: value.bytes });
    }
    return inputs;
}
/** A customer-local preflight, never a worker attestation or preview/promotion grant. */
export async function prepareLocalTestGate(root, stage, definitions, limits, deadline, signal, configuration) {
    if (stage !== 'preview' && stage !== 'promotion')
        invalid();
    if (process.platform !== 'linux')
        throw new CliError('Local test gates currently qualify Linux only.', EXIT.validation, 'local_test_gate_platform_unsupported');
    root = await realpath(root);
    const filename = await projectFile(root, LOCAL_TEST_GATE_CONFIG);
    const source = await read(filename, 65_536, true, deadline, signal);
    let parsed;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(source.content);
        parsed = JSON.parse(text);
        // JSON.parse accepts duplicate keys; a gate policy must be unambiguous.
        if (parseDocument(text, { schema: 'json', strict: true, uniqueKeys: true }).errors.length)
            invalid();
    }
    catch {
        invalid();
    }
    const policy = object(parsed, ['schema', 'inputs', 'stages']);
    if (policy.schema !== 'blinkhost.local-test-gates/v1')
        invalid();
    const declarations = object(policy.inputs, CATEGORIES), stages = object(policy.stages, ['preview', 'promotion']);
    const required = stages[stage];
    if (!Array.isArray(required) || !required.length || required.length > 32)
        invalid();
    for (const [name, checks] of Object.entries(stages)) {
        if (!Array.isArray(checks) || !checks.length || checks.length > 32 || new Set(checks).size !== checks.length)
            invalid();
        for (const id of checks) {
            const definition = definitions.find(row => row.id === id);
            if (typeof id !== 'string' || !definition || definition.kind === 'build' || !definition.results)
                invalid();
        }
        if (name !== 'preview' && name !== 'promotion')
            invalid();
    }
    const paths = [];
    const names = new Set();
    for (const category of CATEGORIES) {
        const values = declarations[category];
        if (!Array.isArray(values) || values.length > LOCAL_TEST_GATE_LIMITS.files || (category === 'source' && !values.length))
            invalid();
        for (const path of values) {
            if (typeof path !== 'string' || names.has(path))
                invalid();
            names.add(path);
            paths.push({ category, path, filename: await projectFile(root, path) });
        }
    }
    for (const path of CONFIGURATION) {
        if (!names.has(path)) {
            names.add(path);
            paths.push({ category: 'configuration', path, filename: await projectFile(root, path) });
        }
    }
    if (paths.length > LOCAL_TEST_GATE_LIMITS.files)
        invalid();
    // Pin the current CLI, installed adapters and Node binary as additional local inputs.
    const tools = new Set([await realpath(process.execPath),
        fileURLToPath(new URL('./local-test-gates.js', import.meta.url)), fileURLToPath(new URL('./workflows.js', import.meta.url)),
        fileURLToPath(new URL('./local-test-command.js', import.meta.url)), fileURLToPath(new URL('./local-test-config.js', import.meta.url)),
        fileURLToPath(new URL('./local-test-results.js', import.meta.url))]);
    const executables = [];
    const addExecutable = async (command, cwd) => {
        const filename = await executable(command, cwd);
        tools.add(filename);
        executables.push({ command, cwd, filename });
    };
    for (const definition of definitions) {
        await addExecutable(definition.command, join(root, definition.cwd));
        if (definition.runner === 'go' || definition.runner === 'rust')
            await addExecutable(definition.runner === 'go' ? 'go' : 'cargo', join(root, definition.cwd));
        if (definition.runner)
            for (const arg of definition.args) {
                const candidate = arg.startsWith('--test-reporter=') ? arg.slice('--test-reporter='.length) : arg;
                if (candidate.startsWith(dirname(fileURLToPath(import.meta.url)) + '/') || candidate === fileURLToPath(new URL('../test-runners/python-unittest.py', import.meta.url)))
                    tools.add(await realpath(candidate));
            }
    }
    for (const [index, filename] of [...tools].sort().entries())
        paths.push({ category: 'cli', path: `tool-${index}`, filename });
    paths.sort((a, b) => `${a.category}/${a.path}`.localeCompare(`${b.category}/${b.path}`));
    const inputs = await snapshot({ root, paths, executables }, deadline, signal);
    if (inputs.find(row => row.path === LOCAL_TEST_GATE_CONFIG).sha256 !== source.sha256)
        invalid();
    if (configuration?.some(before => inputs.find(after => after.path === before.path)?.sha256 !== before.sha256))
        invalid();
    const context = hash(JSON.stringify({ definitions, limits }));
    return { root, stage, required: required, paths, executables, inputs, context, digest: hash(JSON.stringify({ context, inputs })) };
}
export function blockedLocalTestGate(prepared, checks, reason) {
    return { schema: 'blinkhost.local-test-gate/v1', stage: prepared.stage, status: 'blocked', authority: 'customer_runner_reported',
        scope: 'declared_local_inputs', production_authority: false, input_sha256: prepared.digest, observed_input_sha256: null,
        inputs_unchanged: null, inputs: prepared.inputs, reason, checks: prepared.required.map(id => {
            const check = checks.find(row => row.id === id);
            const passed = check?.kind !== 'build' && check?.status === 'succeeded' && !check.report_error
                && check.report?.status === 'passed' && check.report.counts.passed > 0 && !check.report.counts.failed
                && !check.report.counts.skipped && !check.report.counts.unsupported;
            return { id, status: passed ? 'passed' : 'blocked', reason: passed ? null
                    : !check || check.status === 'not_run' ? 'required_check_not_run' : check.kind === 'build' ? 'build_is_not_test_evidence'
                        : check.status !== 'succeeded' ? 'required_execution_failed' : check.report_error ? 'required_result_invalid'
                            : !check.report ? 'required_result_missing' : 'required_tests_not_all_passed' };
        }) };
}
export async function finishLocalTestGate(prepared, checks, deadline, signal) {
    const result = blockedLocalTestGate(prepared, checks, 'required_checks_blocked');
    try {
        const inputs = await snapshot(prepared, deadline, signal);
        result.observed_input_sha256 = hash(JSON.stringify({ context: prepared.context, inputs }));
        result.inputs_unchanged = result.observed_input_sha256 === prepared.digest;
        if (!result.inputs_unchanged)
            result.reason = 'declared_inputs_changed';
        else if (result.checks.every(row => row.status === 'passed')) {
            result.status = 'passed';
            result.reason = null;
        }
    }
    catch (error) {
        result.reason = error instanceof CliError && ['project_test_cancelled', 'project_test_timeout'].includes(error.code)
            ? error.code : 'declared_inputs_unavailable';
    }
    return result;
}
//# sourceMappingURL=local-test-gates.js.map