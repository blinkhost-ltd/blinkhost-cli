import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ManifestError } from '../errors.js';
import { detectManifest } from '../detect.js';
import { parseManifest, serializeManifest } from '../manifest.js';
import { validateProject, writeScaffoldAtomically } from '../project.js';
import { createScaffold } from '../templates.js';
const valid = `schema: blinkhost/v1
application:
  root: .
frontend:
  root: .
  dependency_root: .
  framework: react
  package_manager: npm
  install: npm ci
  build: npm run build
  dev: npm run dev
  output: dist
modules: []
resources:
  databases: []
  secrets: []
preview:
  enabled: true
  database_mode: none
ignore:
  - node_modules
`;
test('manifest parser normalizes the BlinkHost v1 contract', () => {
    const manifest = parseManifest(valid);
    assert.equal(manifest.frontend.framework, 'react');
    assert.equal(parseManifest(serializeManifest(manifest)).schema, 'blinkhost/v1');
});
test('manifest parser rejects duplicate keys, aliases, unknown privileges and traversal', () => {
    for (const source of [
        `${valid}\nschema: blinkhost/v1\n`,
        valid.replace('application:\n  root: .', 'application: &app\n  root: .\ncopy: *app'),
        valid.replace('  root: .\n  dependency_root', '  billing_plan: enterprise\n  root: .\n  dependency_root'),
        valid.replace('  root: .\n  dependency_root', '  root: ../private\n  dependency_root'),
    ])
        assert.throws(() => parseManifest(source), ManifestError);
});
test('scaffold creation is atomic, refuses overwrite and validates declared files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-cli-test-'));
    const target = join(parent, 'study-circle');
    const scaffold = createScaffold({ name: 'study-circle', framework: 'react', packageManager: 'npm', modules: [{ name: 'search', language: 'rust' }], database: 'PRIMARY_DB' });
    await writeScaffoldAtomically(target, scaffold.files, scaffold.manifest);
    const result = await validateProject(target);
    assert.deepEqual(result.errors, []);
    assert.equal(result.manifest.modules[0]?.entrypoint, 'src/lib.rs');
    await assert.rejects(() => writeScaffoldAtomically(target, scaffold.files, scaffold.manifest));
    await rm(parent, { recursive: true, force: true });
});
test('every supported frontend and backend language produces the v1 contract', () => {
    for (const framework of ['astro', 'html', 'react', 'solid', 'svelte', 'vue']) {
        for (const language of ['go', 'javascript', 'python', 'rust', 'typescript']) {
            const scaffold = createScaffold({
                name: 'portable-app', framework, packageManager: 'npm',
                modules: [{ name: `service-${language}`, language }],
            });
            const parsed = parseManifest(serializeManifest(scaffold.manifest));
            assert.equal(parsed.frontend.framework, framework);
            assert.equal(parsed.modules[0]?.language, language);
        }
    }
});
test('init detects only explicit safe function manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-cli-detect-'));
    const moduleRoot = join(root, '_server_islands', 'notifications');
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(join(moduleRoot, 'blinkhost.toml'), 'language = "typescript-wasi"\nentrypoint = "index.ts"\nabi_version = "blinkhost-wasi-1"\nsdk_version = "1.1.0"\n');
    const manifest = await detectManifest(root);
    assert.deepEqual(manifest.modules, [{ name: 'notifications', path: '_server_islands/notifications', language: 'typescript', entrypoint: 'index.ts', abi: 'blinkhost-wasi-1', sdk: '1.1.0' }]);
    await rm(root, { recursive: true, force: true });
});
test('unsupported function languages fail closed with an actionable message', () => {
    const withRuby = valid.replace('modules: []', 'modules:\n  - name: api\n    path: _server_islands/api\n    language: ruby\n    entrypoint: main.rb\n    abi: blinkhost-wasi-1\n    sdk: 1.1.0');
    assert.throws(() => parseManifest(withRuby), /Choose Rust, Go, Python, JavaScript or TypeScript Functions/);
});
test('validation rejects a symbolic-link manifest', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-cli-link-'));
    const source = join(parent, 'source.yaml');
    const project = join(parent, 'project');
    await import('node:fs/promises').then(({ mkdir, symlink }) => mkdir(project).then(() => writeFile(source, valid).then(() => symlink(source, join(project, 'blinkhost.yaml')))));
    await assert.rejects(() => validateProject(project), /regular file/);
    assert.match(await readFile(source, 'utf8'), /blinkhost\/v1/);
    await rm(parent, { recursive: true, force: true });
});
test('validation detects package-manager drift and symbolic-link dependency inputs', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'blinkhost-cli-dependencies-'));
    const target = join(parent, 'project');
    const scaffold = createScaffold({ name: 'project', framework: 'react', packageManager: 'npm', modules: [] });
    await writeScaffoldAtomically(target, scaffold.files, scaffold.manifest);
    await writeFile(join(target, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n');
    const mismatch = await validateProject(target);
    assert.match(mismatch.errors.join(' '), /different package managers/);
    const outside = join(parent, 'outside-lock.json');
    await writeFile(outside, '{}');
    await import('node:fs/promises').then(({ symlink }) => symlink(outside, join(target, 'package-lock.json')));
    await assert.rejects(() => validateProject(target), /symbolic link/);
    await rm(parent, { recursive: true, force: true });
});
//# sourceMappingURL=manifest.test.js.map