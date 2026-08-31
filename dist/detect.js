import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
async function readable(path) {
    try {
        await readFile(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function detectManifest(root) {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error('Project path must be a regular directory.');
    let packageJson = {};
    try {
        const packagePath = join(root, 'package.json');
        if ((await lstat(packagePath)).isSymbolicLink())
            throw new Error('package.json cannot be a symbolic link.');
        packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    let framework = 'html';
    if ('astro' in dependencies)
        framework = 'astro';
    else if ('react' in dependencies)
        framework = 'react';
    else if ('vue' in dependencies)
        framework = 'vue';
    else if ('svelte' in dependencies)
        framework = 'svelte';
    else if ('solid-js' in dependencies)
        framework = 'solid';
    let packageManager = 'npm';
    if (await readable(join(root, 'pnpm-lock.yaml')))
        packageManager = 'pnpm';
    else if (await readable(join(root, 'yarn.lock')))
        packageManager = 'yarn';
    else if (await readable(join(root, 'bun.lock')) || await readable(join(root, 'bun.lockb')))
        packageManager = 'bun';
    const install = packageManager === 'npm' ? 'npm ci' : `${packageManager} install --frozen-lockfile`;
    const modules = [];
    const moduleRoot = join(root, '_server_islands');
    try {
        const entries = (await readdir(moduleRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
        if (entries.length > 100)
            throw new Error('A BlinkHost project cannot declare more than 100 backend modules.');
        const languageMap = {
            'rust-wasi': 'rust', 'go-wasi': 'go', 'python-wasi': 'python',
            'javascript-wasi': 'javascript', 'typescript-wasi': 'typescript',
        };
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(entry.name))
                continue;
            const manifestPath = join(moduleRoot, entry.name, 'blinkhost.toml');
            let source;
            try {
                const metadata = await lstat(manifestPath);
                if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024)
                    continue;
                source = await readFile(manifestPath, 'utf8');
            }
            catch {
                continue;
            }
            const language = /^language\s*=\s*["']([^"']+)["']\s*$/m.exec(source)?.[1];
            const entrypoint = /^entrypoint\s*=\s*["']([^"']+)["']\s*$/m.exec(source)?.[1];
            const abi = /^abi_version\s*=\s*["']([^"']+)["']\s*$/m.exec(source)?.[1] || 'blinkhost-wasi-1';
            const sdk = /^sdk_version\s*=\s*["']([^"']+)["']\s*$/m.exec(source)?.[1] || '1.1.0';
            if (!language || !entrypoint || !languageMap[language])
                continue;
            modules.push({ name: entry.name, path: `_server_islands/${entry.name}`, language: languageMap[language], entrypoint, abi, sdk });
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    return {
        schema: 'blinkhost/v1', application: { root: '.' },
        frontend: {
            root: '.', dependency_root: '.', framework, package_manager: packageManager,
            install: framework === 'html' ? '' : install,
            build: framework === 'html' ? '' : `${packageManager} run build`,
            dev: framework === 'html' ? '' : `${packageManager} run dev`,
            output: framework === 'html' ? '.' : 'dist',
        },
        modules, resources: { databases: [], secrets: [] },
        preview: { enabled: true, database_mode: 'none' },
        ignore: ['.blinkhost', 'node_modules', 'dist'],
    };
}
//# sourceMappingURL=detect.js.map