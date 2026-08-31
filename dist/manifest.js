import { parseDocument, stringify, visit } from 'yaml';
import { ManifestError } from './errors.js';
export const MANIFEST_SCHEMA = 'blinkhost/v1';
export const MANIFEST_FILENAME = 'blinkhost.yaml';
export const MAX_MANIFEST_BYTES = 128 * 1024;
export const SUPPORTED_FRONTENDS = ['astro', 'html', 'react', 'solid', 'svelte', 'vue'];
export const SUPPORTED_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'];
export const SUPPORTED_MODULES = ['go', 'javascript', 'python', 'rust', 'typescript'];
const TOP_LEVEL = new Set(['schema', 'application', 'frontend', 'modules', 'resources', 'preview', 'ignore']);
const APPLICATION_FIELDS = new Set(['root']);
const FRONTEND_FIELDS = new Set(['root', 'dependency_root', 'framework', 'package_manager', 'install', 'build', 'dev', 'output']);
const MODULE_FIELDS = new Set(['name', 'path', 'language', 'entrypoint', 'abi', 'sdk']);
const RESOURCE_FIELDS = new Set(['databases', 'secrets']);
const DATABASE_FIELDS = new Set(['binding', 'schema', 'migrations', 'seeds']);
const PREVIEW_FIELDS = new Set(['enabled', 'database_mode']);
const WINDOWS_NAMES = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);
const MODULE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
function fail(field, message) {
    throw new ManifestError(`${field}: ${message}`);
}
function object(value, field, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(field, 'Must be an object.');
    const result = value;
    const unknown = Object.keys(result).filter((key) => !allowed.has(key)).sort();
    if (unknown.length)
        fail(field, `Unsupported fields: ${unknown.join(', ')}.`);
    return result;
}
function stringValue(value, field, maximum = 512, required = true) {
    if (value === undefined || value === null) {
        if (!required)
            return '';
        fail(field, 'Must be a non-empty string.');
    }
    if (typeof value !== 'string' || (required && !value.trim()))
        fail(field, 'Must be a non-empty string.');
    const normalized = value.trim();
    if (Buffer.byteLength(normalized, 'utf8') > maximum)
        fail(field, `Must not exceed ${maximum} UTF-8 bytes.`);
    if (/[\u0000-\u001f\u007f]/.test(normalized))
        fail(field, 'Control characters are not supported.');
    return normalized;
}
export function normalizeRepositoryPath(value, field, allowRoot = false) {
    const path = stringValue(value, field, 1024);
    if (path === '.' && allowRoot)
        return path;
    if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0'))
        fail(field, 'Must be a repository-relative POSIX path.');
    if (path.endsWith('/') || path === '.' || path === '..' || path.includes('//'))
        fail(field, 'Must be a normalized repository-relative path.');
    const parts = path.split('/');
    if (parts.length > 64)
        fail(field, 'Must not exceed 64 path segments.');
    for (const part of parts) {
        const folded = part.toLowerCase();
        const stem = folded.split('.', 1)[0] ?? folded;
        if (!part || part === '.' || part === '..' || folded === '.git' || WINDOWS_NAMES.has(stem))
            fail(field, `Contains reserved path segment: ${part}.`);
        if (part.endsWith(' ') || part.endsWith('.'))
            fail(field, 'Path segments cannot end with a space or period.');
        if (/[\u0000-\u001f\u007f]/.test(part))
            fail(field, 'Path contains control characters.');
    }
    return parts.join('/');
}
function command(value, field, required = true) {
    const result = stringValue(value, field, 1024, required);
    if (/[\r\n]/.test(result))
        fail(field, 'Build commands must be single-line values.');
    return result;
}
export function parseManifest(raw) {
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    if (bytes.byteLength > MAX_MANIFEST_BYTES)
        fail('manifest', `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes))
        fail('manifest', 'Manifest must be valid UTF-8.');
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    let hasAlias = false;
    visit(document, { Alias: () => { hasAlias = true; } });
    if (hasAlias)
        fail('manifest', 'YAML aliases are not supported.');
    if (document.errors.length)
        fail('manifest', `Manifest YAML is invalid: ${document.errors[0]?.message ?? 'unknown error'}`);
    const rootObject = object(document.toJS({ maxAliasCount: 0 }), 'manifest', TOP_LEVEL);
    if (rootObject.schema !== MANIFEST_SCHEMA)
        fail('schema', `Only ${MANIFEST_SCHEMA} is supported.`);
    const application = object(rootObject.application ?? {}, 'application', APPLICATION_FIELDS);
    const applicationRoot = normalizeRepositoryPath(application.root ?? '.', 'application.root', true);
    const frontend = object(rootObject.frontend, 'frontend', FRONTEND_FIELDS);
    const frontendRoot = normalizeRepositoryPath(frontend.root ?? '.', 'frontend.root', true);
    const dependencyRoot = normalizeRepositoryPath(frontend.dependency_root ?? frontendRoot, 'frontend.dependency_root', true);
    if (dependencyRoot !== '.' && frontendRoot !== dependencyRoot && !frontendRoot.startsWith(`${dependencyRoot}/`))
        fail('frontend.dependency_root', 'Must be the frontend directory or one of its parent directories.');
    const framework = stringValue(frontend.framework, 'frontend.framework', 32).toLowerCase();
    if (!SUPPORTED_FRONTENDS.includes(framework))
        fail('frontend.framework', 'Unsupported frontend framework.');
    const packageManager = stringValue(frontend.package_manager, 'frontend.package_manager', 16).toLowerCase();
    if (!SUPPORTED_MANAGERS.includes(packageManager))
        fail('frontend.package_manager', 'Unsupported package manager.');
    const normalizedFrontend = {
        root: frontendRoot,
        dependency_root: dependencyRoot,
        framework: framework,
        package_manager: packageManager,
        install: command(frontend.install ?? '', 'frontend.install', framework !== 'html'),
        build: command(frontend.build ?? '', 'frontend.build', framework !== 'html'),
        dev: command(frontend.dev, 'frontend.dev', false),
        output: normalizeRepositoryPath(frontend.output, 'frontend.output', framework === 'html'),
    };
    const rawModules = rootObject.modules ?? [];
    if (!Array.isArray(rawModules) || rawModules.length > 100)
        fail('modules', 'Must be an array containing at most 100 modules.');
    const moduleNames = new Set();
    const modulePaths = new Set();
    const modules = rawModules.map((rawModule, index) => {
        const field = `modules.${index}`;
        const module = object(rawModule, field, MODULE_FIELDS);
        const name = stringValue(module.name, `${field}.name`, 64).toLowerCase();
        if (!MODULE_NAME.test(name))
            fail(`${field}.name`, 'Use lowercase letters, numbers and internal hyphens.');
        const path = normalizeRepositoryPath(module.path, `${field}.path`);
        const absolutePath = applicationRoot === '.' ? path : `${applicationRoot}/${path}`;
        const language = stringValue(module.language, `${field}.language`, 16).toLowerCase();
        if (!SUPPORTED_MODULES.includes(language))
            fail(`${field}.language`, 'Choose Rust, Go, Python, JavaScript or TypeScript Functions.');
        if (moduleNames.has(name))
            fail(`${field}.name`, 'Module names must be unique.');
        if (modulePaths.has(absolutePath.toLowerCase()))
            fail(`${field}.path`, 'Module paths must be unique, including case.');
        moduleNames.add(name);
        modulePaths.add(absolutePath.toLowerCase());
        return {
            name,
            path,
            language: language,
            entrypoint: normalizeRepositoryPath(module.entrypoint, `${field}.entrypoint`),
            abi: stringValue(module.abi ?? 'blinkhost-wasi-1', `${field}.abi`, 64),
            sdk: stringValue(module.sdk ?? '1.1', `${field}.sdk`, 32),
        };
    });
    const resources = object(rootObject.resources ?? {}, 'resources', RESOURCE_FIELDS);
    const rawDatabases = resources.databases ?? [];
    if (!Array.isArray(rawDatabases) || rawDatabases.length > 32)
        fail('resources.databases', 'Must be an array containing at most 32 bindings.');
    const bindings = new Set();
    const databases = rawDatabases.map((rawDatabase, index) => {
        const field = `resources.databases.${index}`;
        const database = object(rawDatabase, field, DATABASE_FIELDS);
        const binding = stringValue(database.binding, `${field}.binding`, 128);
        if (!BINDING_NAME.test(binding) || bindings.has(binding))
            fail(`${field}.binding`, 'Bindings must be unique uppercase environment names.');
        bindings.add(binding);
        const result = { binding };
        for (const key of ['schema', 'migrations', 'seeds'])
            if (database[key] !== undefined)
                result[key] = normalizeRepositoryPath(database[key], `${field}.${key}`);
        return result;
    });
    const rawSecrets = resources.secrets ?? [];
    if (!Array.isArray(rawSecrets) || rawSecrets.length > 256)
        fail('resources.secrets', 'Must be an array containing at most 256 names.');
    const secrets = rawSecrets.map((value, index) => stringValue(value, `resources.secrets.${index}`, 128));
    if (new Set(secrets).size !== secrets.length || secrets.some((secret) => !BINDING_NAME.test(secret)))
        fail('resources.secrets', 'Secret names must be unique uppercase environment names.');
    const preview = object(rootObject.preview ?? {}, 'preview', PREVIEW_FIELDS);
    const enabled = preview.enabled ?? true;
    if (typeof enabled !== 'boolean')
        fail('preview.enabled', 'Must be a boolean.');
    const databaseMode = stringValue(preview.database_mode ?? 'none', 'preview.database_mode', 32).toLowerCase();
    if (databaseMode !== 'none' && databaseMode !== 'isolated_branch')
        fail('preview.database_mode', 'Unsupported preview database mode.');
    const rawIgnore = rootObject.ignore ?? [];
    if (!Array.isArray(rawIgnore) || rawIgnore.length > 256)
        fail('ignore', 'Must be an array containing at most 256 paths.');
    return {
        schema: MANIFEST_SCHEMA,
        application: { root: applicationRoot },
        frontend: normalizedFrontend,
        modules,
        resources: { databases, secrets },
        preview: { enabled, database_mode: databaseMode },
        ignore: rawIgnore.map((value, index) => normalizeRepositoryPath(value, `ignore.${index}`)),
    };
}
export function serializeManifest(manifest) {
    return stringify(manifest, { lineWidth: 100, aliasDuplicateObjects: false });
}
//# sourceMappingURL=manifest.js.map