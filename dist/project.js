import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CliError, EXIT } from './errors.js';
import { MANIFEST_FILENAME, parseManifest, serializeManifest } from './manifest.js';
export function resolveLocalPath(input) {
    const value = input ?? '.';
    if (/[\u0000-\u001f\u007f]/.test(value))
        throw new CliError('Project paths cannot contain control characters.', EXIT.usage, 'unsafe_path');
    return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}
async function safeDeclaredPath(root, declared) {
    const target = resolve(root, declared === '.' ? '' : declared);
    const offset = relative(root, target);
    if (offset.startsWith('..') || isAbsolute(offset))
        throw new CliError(`Declared path escapes the project: ${declared}`, EXIT.validation, 'unsafe_path');
    let cursor = root;
    for (const segment of offset.split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, segment);
        try {
            if ((await lstat(cursor)).isSymbolicLink())
                throw new CliError(`Declared path uses a symbolic link: ${declared}`, EXIT.validation, 'symlink_rejected');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                break;
            throw error;
        }
    }
    return target;
}
async function exists(path) {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function regularFile(path) {
    try {
        const stat = await lstat(path);
        return stat.isFile() && !stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}
async function regularDirectory(path) {
    try {
        const stat = await lstat(path);
        return stat.isDirectory() && !stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}
export async function readProjectManifest(root) {
    const manifestPath = join(root, MANIFEST_FILENAME);
    let stat;
    try {
        stat = await lstat(manifestPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            throw new CliError(`No ${MANIFEST_FILENAME} was found.`, EXIT.validation, 'manifest_missing');
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new CliError(`${MANIFEST_FILENAME} must be a regular file, not a symbolic link.`, EXIT.validation, 'manifest_unsafe');
    return parseManifest(await readFile(manifestPath));
}
export async function validateProject(root) {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new CliError('Project path must be a regular directory.', EXIT.validation, 'unsafe_project');
    const manifest = await readProjectManifest(root);
    const errors = [];
    const warnings = [];
    const frontendRoot = await safeDeclaredPath(root, manifest.frontend.root);
    if (!await regularDirectory(frontendRoot))
        errors.push(`Frontend directory does not exist or is not a regular directory: ${manifest.frontend.root}`);
    if (manifest.frontend.framework !== 'html') {
        const dependencyRoot = await safeDeclaredPath(root, manifest.frontend.dependency_root);
        if (!await regularDirectory(dependencyRoot))
            errors.push(`Dependency directory does not exist or is not a regular directory: ${manifest.frontend.dependency_root}`);
        const dependencyPrefix = manifest.frontend.dependency_root === '.' ? '' : `${manifest.frontend.dependency_root}/`;
        const packagePath = await safeDeclaredPath(root, `${dependencyPrefix}package.json`);
        if (!await regularFile(packagePath)) {
            errors.push(`Missing regular package.json in ${manifest.frontend.dependency_root}.`);
        }
        else {
            try {
                const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
                if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson))
                    throw new Error('not an object');
                if (typeof packageJson.packageManager === 'string' && !packageJson.packageManager.startsWith(`${manifest.frontend.package_manager}@`)) {
                    errors.push('package.json and blinkhost.yaml select different package managers.');
                }
            }
            catch {
                errors.push('package.json must contain a valid JSON object.');
            }
        }
        const locks = { npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] };
        const lockResults = await Promise.all(locks[manifest.frontend.package_manager].map(async (name) => {
            const lockPath = await safeDeclaredPath(root, `${dependencyPrefix}${name}`);
            return regularFile(lockPath);
        }));
        if (!lockResults.some(Boolean)) {
            warnings.push(`Add and commit the ${manifest.frontend.package_manager} lockfile for reproducible, faster dependency installation.`);
        }
    }
    for (const module of manifest.modules) {
        const moduleRoot = await safeDeclaredPath(root, module.path);
        const entrypoint = await safeDeclaredPath(moduleRoot, module.entrypoint);
        if (!await regularDirectory(moduleRoot))
            errors.push(`Backend module directory does not exist or is not a regular directory: ${module.path}`);
        if (!await regularFile(entrypoint))
            errors.push(`Backend module entrypoint does not exist or is not a regular file: ${module.path}/${module.entrypoint}`);
    }
    for (const database of manifest.resources.databases) {
        for (const key of ['schema', 'migrations', 'seeds']) {
            const path = database[key];
            if (path) {
                const target = await safeDeclaredPath(root, path);
                const valid = key === 'schema' ? await regularFile(target) : await regularDirectory(target);
                if (!valid)
                    errors.push(`Database ${database.binding} ${key} path has the wrong type or does not exist: ${path}`);
            }
        }
    }
    return { manifest, errors, warnings };
}
export async function writeScaffoldAtomically(target, files, manifest) {
    if (await exists(target))
        throw new CliError(`Refusing to overwrite existing path: ${target}`, EXIT.filesystem, 'target_exists');
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(target)}.blinkhost-`));
    try {
        const all = new Map(files);
        all.set(MANIFEST_FILENAME, serializeManifest(manifest));
        for (const [declaredPath, contents] of all) {
            const destination = resolve(staging, declaredPath);
            if (relative(staging, destination).startsWith('..'))
                throw new CliError(`Unsafe generated path: ${declaredPath}`, EXIT.internal, 'unsafe_template');
            await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
            await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
        }
        await rename(staging, target);
    }
    catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
}
export async function writeManifest(root, manifest, force) {
    const path = join(root, MANIFEST_FILENAME);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new CliError('Project path must be a regular directory.', EXIT.filesystem, 'unsafe_project');
    if (!force && await exists(path))
        throw new CliError(`${MANIFEST_FILENAME} already exists. Use --force only after reviewing the generated manifest.`, EXIT.filesystem, 'manifest_exists');
    if (await exists(path) && (await lstat(path)).isSymbolicLink())
        throw new CliError(`Refusing to replace a symbolic-link ${MANIFEST_FILENAME}.`, EXIT.filesystem, 'manifest_unsafe');
    await writeFile(path, serializeManifest(manifest), { encoding: 'utf8', mode: 0o644 });
}
export async function directoryEntries(root) {
    return readdir(root);
}
export function temporaryProjectRoot() {
    return tmpdir();
}
//# sourceMappingURL=project.js.map