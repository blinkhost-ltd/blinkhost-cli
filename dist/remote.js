import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { spawn } from 'node:child_process';
import { ApiClient, encodeQuery } from './api.js';
import { CliError, EXIT } from './errors.js';
import { resolveLocalPath } from './project.js';
const COLLECTIONS = {
    projects: '/api/sites/',
    repositories: '/api/source-control/repositories/',
    connections: '/api/source-control/connections/',
    previews: '/api/source-control/previews/',
    builds: '/api/source-control/builds/',
    deployments: '/api/deployments/',
    modules: '/api/backend-modules/',
    databases: '/api/databases/',
    bindings: '/api/bindings/',
    assets: '/api/sites/{project}/assets/',
    secrets: '/api/project-secrets/',
    organizations: '/api/organizations/',
    templates: '/api/source-control/template-releases/',
    approvals: '/api/source-control/deployment-approvals/',
    handoffs: '/api/source-control/agency-handoffs/',
    policies: '/api/source-control/enterprise/policies/',
    workloads: '/api/cli/v2/workload-identities/',
};
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
function takeRepeated(args, name) {
    const result = [];
    while (args.includes(name))
        result.push(takeOption(args, name));
    return result;
}
function takeFlag(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return false;
    args.splice(index, 1);
    return true;
}
function noExtra(args) {
    if (args.length)
        throw new CliError(`Unexpected argument: ${args[0]}`, EXIT.usage, 'unexpected_argument');
}
function safeIdentifier(value, label = 'ID') {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
        throw new CliError(`${label} is missing or invalid.`, EXIT.usage, 'invalid_identifier');
    return encodeURIComponent(value);
}
function validIdempotencyKey(value) {
    if (!value || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value))
        throw new CliError('Idempotency keys must be from 1 to 256 bytes and cannot contain control characters.', EXIT.usage, 'invalid_idempotency_key');
    return value;
}
async function readPayload(value) {
    if (!value)
        return {};
    let raw = value;
    if (value.startsWith('@')) {
        const path = resolveLocalPath(value.slice(1));
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
            throw new CliError('Payload files must be regular files no larger than 1 MiB.', EXIT.validation, 'invalid_payload_file');
        raw = await readFile(path, 'utf8');
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error();
        return parsed;
    }
    catch {
        throw new CliError('Request data must be a JSON object or @path to a JSON file.', EXIT.usage, 'invalid_request_data');
    }
}
function queryString(pairs) {
    const query = new URLSearchParams();
    for (const pair of pairs) {
        const separator = pair.indexOf('=');
        if (separator < 1)
            throw new CliError('Use --query name=value.', EXIT.usage, 'invalid_query');
        query.append(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const value = query.toString();
    return value ? `?${value}` : '';
}
function collectionPath(group, project) {
    const template = COLLECTIONS[group];
    if (!template)
        throw new CliError(`Unknown remote resource: ${group}.`, EXIT.usage, 'unknown_resource');
    if (template.includes('{project}'))
        return template.replace('{project}', safeIdentifier(project, 'Project ID'));
    return template;
}
export async function runRemote(group, input, profile) {
    const args = [...input];
    const action = args.shift() || 'list';
    const project = takeOption(args, '--project');
    const query = takeRepeated(args, '--query');
    const dataOption = takeOption(args, '--data');
    const client = await ApiClient.create(profile);
    const base = collectionPath(group, project);
    const data = await readPayload(dataOption);
    if (action === 'list') {
        noExtra(args);
        return client.request(`${base}${queryString(query)}`);
    }
    if (action === 'get') {
        const id = safeIdentifier(args.shift());
        noExtra(args);
        return client.request(`${base}${id}/${queryString(query)}`);
    }
    if (action === 'create') {
        noExtra(args);
        return client.request(base, { method: 'POST', body: JSON.stringify(data) });
    }
    if (action === 'update') {
        const id = safeIdentifier(args.shift());
        noExtra(args);
        return client.request(`${base}${id}/`, { method: 'PATCH', body: JSON.stringify(data) });
    }
    if (action === 'delete') {
        const idRaw = args.shift();
        const id = safeIdentifier(idRaw);
        const confirmed = takeOption(args, '--confirm');
        noExtra(args);
        if (confirmed !== idRaw)
            throw new CliError('Repeat the resource ID with --confirm before deleting it.', EXIT.usage, 'confirmation_required');
        return client.request(`${base}${id}/`, { method: 'DELETE' });
    }
    if (action === 'action') {
        const id = safeIdentifier(args.shift());
        const operation = safeIdentifier(args.shift(), 'Action');
        noExtra(args);
        return client.request(`${base}${id}/${operation}/`, { method: 'POST', body: JSON.stringify(data) });
    }
    throw new CliError(`Unknown ${group} action: ${action}.`, EXIT.usage, 'unknown_action');
}
export async function runFunctions(input, profile) {
    const args = [...input];
    const resource = args.shift();
    const action = args.shift() || 'list';
    const moduleId = safeIdentifier(args.shift(), 'Module ID');
    const client = await ApiClient.create(profile);
    if (resource === 'triggers') {
        const base = `/api/backend-modules/${moduleId}/triggers/`;
        if (action === 'list') {
            noExtra(args);
            return client.request(base);
        }
        if (action === 'create') {
            const data = await readPayload(takeOption(args, '--data'));
            noExtra(args);
            return client.request(base, { method: 'POST', body: JSON.stringify(data) });
        }
        const triggerIdRaw = args.shift();
        const triggerId = safeIdentifier(triggerIdRaw, 'Trigger ID');
        if (action === 'update') {
            const data = await readPayload(takeOption(args, '--data'));
            noExtra(args);
            return client.request(`${base}${triggerId}/`, { method: 'PATCH', body: JSON.stringify(data) });
        }
        if (action === 'delete') {
            const confirmed = takeOption(args, '--confirm');
            noExtra(args);
            if (confirmed !== triggerIdRaw)
                throw new CliError('Repeat the trigger ID with --confirm before deleting it.', EXIT.usage, 'confirmation_required');
            return client.request(`${base}${triggerId}/`, { method: 'DELETE' });
        }
        throw new CliError(`Unknown trigger action: ${action}.`, EXIT.usage, 'unknown_action');
    }
    if (resource === 'invoke') {
        if (action !== 'run')
            throw new CliError('Use `functions invoke run MODULE_ID TRIGGER_ID`.', EXIT.usage, 'invalid_function_command');
        const triggerId = safeIdentifier(args.shift(), 'Trigger ID');
        const payload = await readPayload(takeOption(args, '--data'));
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 262_144)
            throw new CliError('Function payloads cannot exceed 256 KiB.', EXIT.validation, 'function_payload_too_large');
        const idempotencyKey = validIdempotencyKey(takeOption(args, '--idempotency-key') || randomUUID());
        noExtra(args);
        return client.request(`/api/backend-modules/${moduleId}/triggers/${triggerId}/invoke/`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ payload }) });
    }
    if (resource === 'invocations') {
        const base = `/api/backend-modules/${moduleId}/invocations/`;
        if (action === 'list') {
            noExtra(args);
            return client.request(base);
        }
        const invocationId = safeIdentifier(args.shift(), 'Invocation ID');
        if (action === 'get') {
            noExtra(args);
            return client.request(`${base}${invocationId}/`);
        }
        if (action === 'result') {
            noExtra(args);
            return client.request(`${base}${invocationId}/result/`);
        }
        if (action === 'cancel') {
            noExtra(args);
            return client.request(`${base}${invocationId}/cancel/`, { method: 'POST', body: '{}' });
        }
        if (action === 'retry') {
            const idempotencyKey = validIdempotencyKey(takeOption(args, '--idempotency-key') || randomUUID());
            noExtra(args);
            return client.request(`${base}${invocationId}/retry/`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: '{}' });
        }
        throw new CliError(`Unknown invocation action: ${action}.`, EXIT.usage, 'unknown_action');
    }
    throw new CliError('Use `functions triggers`, `functions invoke`, or `functions invocations`.', EXIT.usage, 'invalid_function_command');
}
export async function writeProjectLink(projectId, profile, root) {
    safeIdentifier(projectId, 'Project ID');
    const directory = join(resolveLocalPath(root), '.blinkhost');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, 'project.json');
    try {
        if ((await lstat(target)).isSymbolicLink())
            throw new CliError('Refusing to replace a symbolic project link.', EXIT.filesystem, 'unsafe_project_link');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const record = { schema: 'blinkhost/project-link/v1', project_id: projectId, profile };
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return record;
}
export async function readProjectLink(root) {
    const path = join(resolveLocalPath(root), '.blinkhost', 'project.json');
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
        throw new CliError('The local BlinkHost project link is unsafe or invalid.', EXIT.validation, 'invalid_project_link');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.schema !== 'blinkhost/project-link/v1')
        throw new CliError('The local BlinkHost project link uses an unsupported schema.', EXIT.validation, 'invalid_project_link');
    safeIdentifier(record.project_id, 'Project ID');
    return record;
}
export async function unlinkProject(root) {
    const path = join(resolveLocalPath(root), '.blinkhost', 'project.json');
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new CliError('The local BlinkHost project link is unsafe or invalid.', EXIT.validation, 'invalid_project_link');
    await unlink(path);
    return { unlinked: true };
}
export async function projectStatus(profile) {
    const link = await readProjectLink();
    const client = await ApiClient.create(profile || link.profile);
    const [project, connections] = await Promise.all([
        client.request(`/api/sites/${encodeURIComponent(link.project_id)}/`),
        client.request(`/api/source-control/connections/?project=${encodeURIComponent(link.project_id)}`),
    ]);
    return { link, project, connections };
}
export async function syncProject(kind, input, profile) {
    const args = [...input];
    const connection = safeIdentifier(args.shift(), 'Connection ID');
    const data = await readPayload(takeOption(args, '--data'));
    noExtra(args);
    const client = await ApiClient.create(profile);
    return client.request(`/api/source-control/connections/${connection}/${kind}/`, { method: 'POST', body: JSON.stringify(data) });
}
async function readStdin(limit = 64 * 1024) {
    if (stdin.isTTY)
        throw new CliError('Pipe the secret value through standard input; values are never accepted as command arguments.', EXIT.usage, 'secret_stdin_required');
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > limit)
            throw new CliError('Secret values must not exceed 64 KiB.', EXIT.validation, 'secret_too_large');
        chunks.push(buffer);
    }
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!value)
        throw new CliError('The secret value is empty.', EXIT.validation, 'secret_empty');
    return value;
}
export async function runSecrets(input, profile) {
    const args = [...input];
    const action = args.shift() || 'list';
    const client = await ApiClient.create(profile);
    if (action === 'list') {
        const project = takeOption(args, '--project');
        noExtra(args);
        return client.request(`/api/project-secrets/${encodeQuery({ site_id: project })}`);
    }
    if (action === 'set') {
        const key = args.shift();
        const project = takeOption(args, '--project');
        const scope = takeOption(args, '--environment') || 'production';
        const expires = takeOption(args, '--expires-in-days');
        noExtra(args);
        if (!key || !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || !project)
            throw new CliError('Use `secrets set NAME --project ID` with an uppercase secret name.', EXIT.usage, 'invalid_secret');
        const value = await readStdin();
        return client.request('/api/project-secrets/', { method: 'POST', body: JSON.stringify({ site: project, key, scope, value, ...(expires ? { expires_in_days: Number(expires) } : {}) }) });
    }
    if (action === 'rotate') {
        const id = safeIdentifier(args.shift(), 'Secret ID');
        noExtra(args);
        const value = await readStdin();
        return client.request(`/api/project-secrets/${id}/rotate/`, { method: 'POST', body: JSON.stringify({ value, reason: 'CLI rotation' }) });
    }
    if (action === 'delete') {
        const raw = args.shift();
        const id = safeIdentifier(raw, 'Secret ID');
        const confirmed = takeOption(args, '--confirm');
        noExtra(args);
        if (confirmed !== raw)
            throw new CliError('Repeat the secret ID with --confirm before deleting it.', EXIT.usage, 'confirmation_required');
        return client.request(`/api/project-secrets/${id}/`, { method: 'DELETE' });
    }
    throw new CliError(`Unknown secrets action: ${action}.`, EXIT.usage, 'unknown_action');
}
export async function rawApi(input, profile) {
    const args = [...input];
    const method = (args.shift() || 'GET').toUpperCase();
    const path = args.shift();
    const data = await readPayload(takeOption(args, '--data'));
    noExtra(args);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        throw new CliError('API method must be GET, POST, PUT, PATCH, or DELETE.', EXIT.usage, 'invalid_method');
    if (!path || path.includes('://') || /[%\\\r\n]/.test(path))
        throw new CliError('Use a normalized customer API path beginning with /api/.', EXIT.usage, 'invalid_api_path');
    const parsed = new URL(path, 'https://api.blinkhost.me');
    if (!parsed.pathname.startsWith('/api/') || parsed.pathname.includes('/../') || parsed.pathname.startsWith('/api/internal/') || parsed.pathname.startsWith('/api/ops/') || parsed.pathname.startsWith('/api/auth/'))
        throw new CliError('Internal, staff, and authentication API paths are unavailable.', EXIT.usage, 'invalid_api_path');
    if (method !== 'GET' && parsed.pathname.startsWith('/api/project-secrets/'))
        throw new CliError('Use the dedicated `blinkhost secrets` commands so values never enter shell history.', EXIT.usage, 'unsafe_secret_command');
    const client = await ApiClient.create(profile);
    return client.request(path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(data) }) });
}
export async function waitForRemote(group, input, profile) {
    const args = [...input];
    const id = safeIdentifier(args.shift());
    const timeoutRaw = takeOption(args, '--timeout') || '1200';
    noExtra(args);
    const timeout = Number(timeoutRaw);
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600)
        throw new CliError('Timeout must be an integer from 10 to 3600 seconds.', EXIT.usage, 'invalid_timeout');
    const client = await ApiClient.create(profile);
    const base = collectionPath(group);
    const deadline = Date.now() + timeout * 1000;
    const success = new Set(['ready', 'succeeded', 'success', 'completed', 'active', 'deployed']);
    const failure = new Set(['failed', 'cancelled', 'canceled', 'expired', 'revoked']);
    while (Date.now() < deadline) {
        const data = await client.request(`${base}${id}/`);
        const state = String(data.status || data.state || data.phase || '').toLowerCase();
        if (success.has(state))
            return data;
        if (failure.has(state))
            throw new CliError(`${group.slice(0, -1)} ${id} finished with status ${state}.`, EXIT.remote, `${group.slice(0, -1)}_failed`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new CliError(`Timed out waiting for ${group.slice(0, -1)} ${id}.`, EXIT.network, 'wait_timeout');
}
export async function openPreview(input, profile, launchBrowser = true) {
    const args = [...input];
    const id = safeIdentifier(args.shift());
    noExtra(args);
    const client = await ApiClient.create(profile);
    const data = await client.request(`${collectionPath('previews')}${id}/`);
    const value = data.url || data.preview_url || data.public_url;
    if (typeof value !== 'string')
        throw new CliError('This preview does not have a ready URL.', EXIT.conflict, 'preview_not_ready');
    const url = new URL(value);
    const trusted = url.protocol === 'https:' && (url.hostname === 'preview.blinkhost.me' || url.hostname.endsWith('.preview.blinkhost.me') || url.hostname.endsWith('.blinkhost.website'));
    if (!trusted || url.username || url.password)
        throw new CliError('BlinkHost returned an untrusted preview URL.', EXIT.remote, 'preview_url_untrusted');
    if (launchBrowser) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
        const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url.toString()] : [url.toString()];
        const child = spawn(command, commandArgs, { detached: true, shell: false, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
    }
    return { id: decodeURIComponent(id), url: url.toString(), browser_opened: launchBrowser };
}
const ASSET_MEDIA_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};
export async function uploadAsset(input, profile) {
    const args = [...input];
    const source = args.shift();
    const project = takeOption(args, '--project');
    const parentId = takeOption(args, '--parent');
    const revision = takeOption(args, '--revision');
    const replaceAssetId = takeOption(args, '--replace');
    noExtra(args);
    if (!source || !project)
        throw new CliError('Use `assets upload FILE --project PROJECT_ID`.', EXIT.usage, 'asset_arguments_required');
    const path = resolveLocalPath(source);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1)
        throw new CliError('Assets must be non-empty regular files, not symbolic links.', EXIT.validation, 'invalid_asset_file');
    const mediaType = ASSET_MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mediaType)
        throw new CliError('Upload PNG, JPEG, GIF, WebP, ICO, WOFF, WOFF2, MP3, or MP4 files.', EXIT.validation, 'asset_type_not_supported');
    const body = await readFile(path);
    const checksum = createHash('sha256').update(body).digest('hex');
    const client = await ApiClient.create(profile);
    const reservation = await client.request(`/api/sites/${encodeURIComponent(project)}/assets/`, { method: 'POST', body: JSON.stringify({ name: basename(path), media_type: mediaType, size_bytes: body.length, checksum_sha256: checksum, ...(parentId ? { parent_id: parentId } : {}), ...(revision ? { revision } : {}), ...(replaceAssetId ? { replace_asset_id: replaceAssetId } : {}) }) });
    let uploadUrl;
    try {
        uploadUrl = new URL(reservation.upload_url);
    }
    catch {
        throw new CliError('BlinkHost returned an invalid upload address.', EXIT.remote, 'asset_upload_url_invalid');
    }
    if (uploadUrl.protocol !== 'https:' || !uploadUrl.hostname.endsWith('.blob.core.windows.net'))
        throw new CliError('BlinkHost returned an untrusted upload address.', EXIT.remote, 'asset_upload_url_untrusted');
    const uploaded = await fetch(uploadUrl, { method: 'PUT', redirect: 'error', headers: { ...reservation.required_headers, 'Content-Length': String(body.length) }, body });
    if (!uploaded.ok)
        throw new CliError(`Asset storage rejected the upload with HTTP ${uploaded.status}.`, EXIT.remote, 'asset_upload_failed');
    for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
            return await client.request(`/api/sites/${encodeURIComponent(project)}/assets/${encodeURIComponent(reservation.asset_id)}/complete/`, { method: 'POST', body: JSON.stringify({ ...(revision ? { revision } : {}) }) });
        }
        catch (error) {
            if (!(error instanceof CliError) || error.code !== 'api_409' || attempt === 14)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    throw new CliError('Asset validation did not complete in time.', EXIT.remote, 'asset_validation_timeout');
}
//# sourceMappingURL=remote.js.map