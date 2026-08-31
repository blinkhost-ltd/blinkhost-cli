const VERSIONS = {
    vite: '6.4.3', typescript: '5.9.3', react: '19.2.8', vue: '3.5.40',
    svelte: '5.56.8', solid: '1.9.14', astro: '7.1.6',
};
function commands(manager) {
    return {
        install: manager === 'npm' ? 'npm ci' : `${manager} install --frozen-lockfile`,
        build: `${manager} run build`,
        dev: `${manager} run dev`,
    };
}
function frontendFiles(name, framework) {
    const files = new Map();
    files.set('.npmrc', 'engine-strict=true\nignore-scripts=true\naudit=false\nfund=false\nprefer-offline=true\n');
    if (framework === 'html') {
        files.set('index.html', '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlinkHost project</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Ready to build on BlinkHost</h1></main><script type="module" src="script.js"></script></body></html>\n');
        files.set('style.css', ':root { font-family: Inter, system-ui, sans-serif; color-scheme: dark; }\nbody { margin: 0; padding: 3rem; background: #071113; color: #f8fafc; }\n');
        files.set('script.js', "console.info('BlinkHost project ready');\n");
        return files;
    }
    if (framework === 'astro') {
        files.set('package.json', JSON.stringify({ name, private: true, version: '0.1.0', type: 'module', scripts: { dev: 'astro dev --host 0.0.0.0 --port 3000', build: 'astro build' }, dependencies: { astro: VERSIONS.astro } }, null, 2) + '\n');
        files.set('astro.config.mjs', "import { defineConfig } from 'astro/config';\nexport default defineConfig({ server: { host: '0.0.0.0', port: 3000 } });\n");
        files.set('src/pages/index.astro', '---\nconst title = "Ready to build on BlinkHost";\n---\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{title}</title></head><body><main><h1>{title}</h1></main></body></html>\n');
        return files;
    }
    const base = { name, private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite --host 0.0.0.0 --port 3000', build: 'vite build' } };
    files.set('index.html', '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlinkHost project</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
    if (framework === 'react') {
        files.set('package.json', JSON.stringify({ ...base, dependencies: { react: VERSIONS.react, 'react-dom': VERSIONS.react }, devDependencies: { '@vitejs/plugin-react': '4.7.0', '@types/react': '19.2.17', '@types/react-dom': '19.2.3', typescript: VERSIONS.typescript, vite: VERSIONS.vite } }, null, 2) + '\n');
        files.set('vite.config.ts', "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { host: '0.0.0.0', port: 3000 } });\n");
        files.set('src/main.tsx', "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><main><h1>Ready to build on BlinkHost</h1></main></React.StrictMode>);\n");
    }
    else if (framework === 'vue') {
        files.set('package.json', JSON.stringify({ ...base, dependencies: { vue: VERSIONS.vue }, devDependencies: { '@vitejs/plugin-vue': '5.2.4', typescript: VERSIONS.typescript, vite: VERSIONS.vite, 'vue-tsc': '3.3.8' } }, null, 2) + '\n');
        files.set('vite.config.ts', "import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\nexport default defineConfig({ plugins: [vue()], server: { host: '0.0.0.0', port: 3000 } });\n");
        files.set('index.html', files.get('index.html').replace('/src/main.tsx', '/src/main.ts'));
        files.set('src/main.ts', "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');\n");
        files.set('src/App.vue', '<template><main><h1>Ready to build on BlinkHost</h1></main></template>\n');
    }
    else if (framework === 'svelte') {
        files.set('package.json', JSON.stringify({ ...base, devDependencies: { '@sveltejs/vite-plugin-svelte': '5.1.1', svelte: VERSIONS.svelte, vite: VERSIONS.vite } }, null, 2) + '\n');
        files.set('vite.config.ts', "import { defineConfig } from 'vite';\nimport { svelte } from '@sveltejs/vite-plugin-svelte';\nexport default defineConfig({ plugins: [svelte()], server: { host: '0.0.0.0', port: 3000 } });\n");
        files.set('index.html', files.get('index.html').replace('/src/main.tsx', '/src/main.ts'));
        files.set('src/main.ts', "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root')! });\n");
        files.set('src/App.svelte', '<main><h1>Ready to build on BlinkHost</h1></main>\n');
    }
    else {
        files.set('package.json', JSON.stringify({ ...base, dependencies: { 'solid-js': VERSIONS.solid }, devDependencies: { 'vite-plugin-solid': '2.11.14', vite: VERSIONS.vite } }, null, 2) + '\n');
        files.set('vite.config.ts', "import { defineConfig } from 'vite';\nimport solid from 'vite-plugin-solid';\nexport default defineConfig({ plugins: [solid()], server: { host: '0.0.0.0', port: 3000 } });\n");
        files.set('src/main.tsx', "import { render } from 'solid-js/web';\nrender(() => <main><h1>Ready to build on BlinkHost</h1></main>, document.getElementById('root')!);\n");
    }
    files.set('src/style.css', ':root { font-family: Inter, system-ui, sans-serif; color-scheme: dark; }\nbody { margin: 0; padding: 3rem; background: #071113; color: #f8fafc; }\n');
    files.set('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, jsx: framework === 'solid' ? 'preserve' : 'react-jsx' }, include: ['src'] }, null, 2) + '\n');
    return files;
}
function moduleFiles(module) {
    const root = `_server_islands/${module.name}`;
    const files = new Map();
    if (module.language === 'python') {
        files.set(`${root}/main.py`, 'def handler(request):\n    return {"status": 200, "body": {"ok": True}}\n');
        files.set(`${root}/requirements.txt`, '# Add pinned runtime dependencies here.\n');
        return { entrypoint: 'main.py', files };
    }
    if (module.language === 'go') {
        files.set(`${root}/go.mod`, `module blinkhost/${module.name}\n\ngo 1.23\n`);
        files.set(`${root}/main.go`, 'package main\n\nfunc main() {}\n');
        return { entrypoint: 'main.go', files };
    }
    if (module.language === 'javascript' || module.language === 'typescript') {
        const typescript = module.language === 'typescript';
        const entrypoint = typescript ? 'index.ts' : 'index.js';
        const runtime = typescript ? 'typescript-wasi' : 'javascript-wasi';
        const packageName = `blinkhost-${module.name}-function`;
        files.set(`${root}/blinkhost.toml`, `schema_version = 1\nlanguage = "${runtime}"\nentrypoint = "${entrypoint}"\nabi_version = "blinkhost-wasi-1"\nsdk_version = "1.1.0"\n`);
        files.set(`${root}/package.json`, JSON.stringify({ name: packageName, version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n');
        files.set(`${root}/package-lock.json`, JSON.stringify({ name: packageName, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: packageName, version: '1.0.0' } } }, null, 2) + '\n');
        const declaration = typescript ? 'interface FunctionRequest { json(): unknown }\n\n' : '';
        const annotation = typescript ? ': FunctionRequest' : '';
        files.set(`${root}/${entrypoint}`, `${declaration}export default function handler(request${annotation}) {\n  return {\n    status: 200,\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify({ ok: true, received: request.json() }),\n  };\n}\n`);
        return { entrypoint, files };
    }
    files.set(`${root}/Cargo.toml`, `[package]\nname = "${module.name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n`);
    files.set(`${root}/src/lib.rs`, '#[no_mangle]\npub extern "C" fn blinkhost_module_version() -> u32 { 1 }\n');
    return { entrypoint: 'src/lib.rs', files };
}
export function createScaffold(options) {
    const packageCommands = commands(options.packageManager);
    const files = frontendFiles(options.name, options.framework);
    const modules = [];
    for (const item of options.modules) {
        const generated = moduleFiles(item);
        for (const [path, contents] of generated.files)
            files.set(path, contents);
        modules.push({ name: item.name, path: `_server_islands/${item.name}`, language: item.language, entrypoint: generated.entrypoint, abi: 'blinkhost-wasi-1', sdk: '1.1' });
    }
    const databases = options.database ? [{ binding: options.database, schema: `database/${options.database}/schema.sql`, migrations: `database/${options.database}/migrations` }] : [];
    if (options.database) {
        files.set(`database/${options.database}/schema.sql`, '-- Keep the current reviewable schema here.\n');
        files.set(`database/${options.database}/migrations/README.md`, 'Add ordered, forward-only SQL migrations in this directory.\n');
    }
    files.set('.gitignore', 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.blinkhost/\n');
    files.set('README.md', `# ${options.name}\n\nCreated with the BlinkHost CLI. Run \`blinkhost validate\` before connecting this repository.\n`);
    return {
        manifest: {
            schema: 'blinkhost/v1', application: { root: '.' },
            frontend: {
                root: '.', dependency_root: '.', framework: options.framework, package_manager: options.packageManager,
                install: options.framework === 'html' ? '' : packageCommands.install,
                build: options.framework === 'html' ? '' : packageCommands.build,
                dev: options.framework === 'html' ? '' : packageCommands.dev,
                output: options.framework === 'html' ? '.' : 'dist',
            },
            modules,
            resources: { databases, secrets: [] },
            preview: { enabled: true, database_mode: options.database ? 'isolated_branch' : 'none' },
            ignore: ['.blinkhost', 'node_modules', 'dist'],
        },
        files,
    };
}
//# sourceMappingURL=templates.js.map