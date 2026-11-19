import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from './errors.js';
import { MANIFEST_FILENAME } from './manifest.js';
import { validateNodeTestArguments } from './local-test-node-arguments.js';
export const LOCAL_TEST_CONFIG = 'blinkhost.tests.json';
export const TEST_DISCOVERY_LIMITS = { directories: 2048, entries: 16_384, depth: 8, projects: 128 };
const OMIT = new Set(['node_modules', '.git', '.next', 'target', 'dist', 'build', 'coverage', '.cache', '.venv', 'venv', '__pycache__', 'vendor']);
function installedRunner(runner, args) {
    const installed = (path) => fileURLToPath(new URL(path, import.meta.url));
    if (runner === 'python-unittest')
        return { command: 'python3', args: ['-B', installed('../test-runners/python-unittest.py'), ...args] };
    if (runner === 'node') {
        validateNodeTestArguments(args);
        return { command: process.execPath, args: ['--test', `--test-reporter=${installed('./local-test-node-reporter.js')}`, ...args] };
    }
    return { command: process.execPath, args: [installed(`./local-test-${runner}-runner.js`), ...args] };
}
function invalid(message) {
    throw new CliError(message, EXIT.validation, 'invalid_local_test_config');
}
function object(value, fields, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid(`${name} must be an object.`);
    const row = value;
    if (Object.keys(row).some(key => !fields.includes(key)))
        invalid(`${name} contains an unsupported field.`);
    return row;
}
/** Customer-selected paths stay inside the project and cannot traverse existing symlinks. */
export async function localCheckDirectory(root, value) {
    if (typeof value !== 'string' || !value || value.length > 1024
        || /[\u0000-\u001f\u007f\\]/.test(value) || isAbsolute(value))
        invalid('Check cwd must be a relative project directory.');
    const target = resolve(root, value);
    const offset = relative(root, target);
    if (offset === '..' || /^\.\.[\\/]/.test(offset) || isAbsolute(offset))
        invalid('Check cwd escapes the project.');
    let cursor = root;
    for (const part of offset.split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, part);
        const stat = await lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            invalid('Check cwd must use regular project directories.');
    }
    return offset.replaceAll('\\', '/') || '.';
}
export async function readLocalTestConfig(root, manifest) {
    const path = join(root, LOCAL_TEST_CONFIG);
    let file;
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            invalid(`${LOCAL_TEST_CONFIG} must be a regular file.`);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    let source;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65_536)
            invalid(`${LOCAL_TEST_CONFIG} exceeds the 64 KiB limit.`);
        // Bound the read even if a local editor grows the file after fstat.
        const buffer = Buffer.alloc(65_537);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 65_536)
            invalid(`${LOCAL_TEST_CONFIG} exceeds the 64 KiB limit.`);
        source = buffer.subarray(0, bytesRead);
    }
    finally {
        await file.close();
    }
    let parsed;
    try {
        parsed = JSON.parse(source.toString('utf8'));
    }
    catch {
        invalid(`${LOCAL_TEST_CONFIG} must contain valid JSON.`);
    }
    const config = object(parsed, ['schema', 'checks'], LOCAL_TEST_CONFIG);
    if (config.schema !== 'blinkhost.local-test-config/v1')
        invalid('Unsupported local test configuration schema.');
    if (!Array.isArray(config.checks) || config.checks.length < 1 || config.checks.length > 32)
        invalid('Configure between one and 32 local checks.');
    const ids = new Set();
    const results = [];
    for (const value of config.checks) {
        const row = object(value, ['id', 'target', 'cwd', 'command', 'runner', 'args', 'kind', 'profile', 'results'], 'Check');
        if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.id) || ids.has(row.id))
            invalid('Check IDs must be unique safe names.');
        ids.add(row.id);
        const module = manifest.modules.find(item => row.target === `module:${item.name}`);
        if (row.target !== 'frontend' && row.target !== 'project' && !module)
            invalid('Check target must name frontend, project or a declared module:<name>.');
        const runner = row.runner;
        if (row.runner !== undefined) {
            if (typeof row.runner !== 'string' || !['node', 'python-unittest', 'go', 'rust'].includes(row.runner) || row.command !== undefined)
                invalid('Choose one installed runner or a custom command.');
        }
        else if (typeof row.command !== 'string' || !row.command || row.command.length > 1024 || /[\u0000-\u001f\u007f]/.test(row.command))
            invalid('Check command must be a bounded executable name or path.');
        const args = row.args ?? [];
        if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))
            || args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > 32_768)
            invalid('Check args must be bounded literal strings.');
        if (!['test', 'integration', 'build'].includes(String(row.kind)))
            invalid('Check kind must be test, integration or build.');
        const profile = row.profile ?? 'unspecified';
        if (!['native', 'wasm', 'browser', 'unspecified'].includes(String(profile)))
            invalid('Unsupported declared check profile.');
        if (runner && (profile !== 'native' || row.kind !== 'test'))
            invalid('Installed runners require kind test and profile native.');
        if (row.results !== undefined) {
            const report = object(row.results, ['format'], 'Check results');
            if (report.format !== 'blinkhost/v1' || row.kind === 'build')
                invalid('Structured results require a test/integration check and blinkhost/v1 format.');
        }
        const cwd = await localCheckDirectory(root, row.cwd ?? module?.path ?? (row.target === 'frontend' ? manifest.frontend.dependency_root : '.'));
        const execution = runner ? installedRunner(runner, args) : { command: row.command, args: args };
        results.push({ id: row.id, target: row.target, cwd, ...execution,
            kind: row.kind, profile: profile,
            ...(runner ? { runner } : {}),
            ...(runner || row.results !== undefined ? { results: { format: 'blinkhost/v1' } } : {}) });
    }
    return results;
}
/** Discover only project manifests, never install dependencies or execute discovered projects. */
export async function discoverLocalProjects(root, signal) {
    const result = { nested_projects: [], complete: true, directories_scanned: 0,
        entries_scanned: 0, limits: TEST_DISCOVERY_LIMITS };
    const pending = [{ path: '.', depth: 0 }];
    for (let index = 0; index < pending.length; index++) {
        if (signal?.aborted)
            throw new CliError('Project discovery was cancelled.', signal.reason === 'SIGTERM' ? 143 : 130, 'project_test_cancelled');
        if (result.directories_scanned >= TEST_DISCOVERY_LIMITS.directories) {
            result.complete = false;
            break;
        }
        const current = pending[index];
        const directory = await opendir(join(root, current.path));
        result.directories_scanned++;
        for await (const entry of directory) {
            if (result.entries_scanned === TEST_DISCOVERY_LIMITS.entries) {
                result.complete = false;
                return result;
            }
            result.entries_scanned++;
            if (current.depth && entry.name === MANIFEST_FILENAME) {
                if (result.nested_projects.length === TEST_DISCOVERY_LIMITS.projects) {
                    result.complete = false;
                    return result;
                }
                result.nested_projects.push({ path: current.path, status: 'not_run', reason: entry.isFile() ? 'run_explicitly' : 'unsafe_manifest' });
            }
            if (!entry.isDirectory() || OMIT.has(entry.name))
                continue;
            if (current.depth === TEST_DISCOVERY_LIMITS.depth || pending.length === TEST_DISCOVERY_LIMITS.directories) {
                result.complete = false;
                continue;
            }
            const path = current.path === '.' ? entry.name : `${current.path}/${entry.name}`;
            pending.push({ path, depth: current.depth + 1 });
        }
    }
    result.nested_projects.sort((a, b) => a.path.localeCompare(b.path));
    return result;
}
//# sourceMappingURL=local-test-config.js.map