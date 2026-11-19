import { stdin } from 'node:process';
import { parseDocument } from 'yaml';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';
const LIMIT = 64 * 1024;
const BASE = '/api/source-control/test-credential-fixtures/';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function invalid() {
    throw new CliError('Invalid test credential input. Use the documented JSON contract and supply values only through --stdin.', EXIT.validation, 'test_credentials_invalid');
}
function object(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
        invalid();
    return value;
}
function uuid(value) {
    if (typeof value !== 'string' || !UUID.test(value) || value === '00000000-0000-0000-0000-000000000000')
        invalid();
    return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
        invalid();
    return value;
}
function reference(value) {
    const row = object(value, ['name', 'scope', 'version', 'fixture_id', 'fixture_revision']);
    if (typeof row.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name)
        || !['preview', 'production', 'development'].includes(String(row.scope)))
        invalid();
    return { name: row.name, scope: row.scope, version: integer(row.version, 2_147_483_647),
        fixture_id: uuid(row.fixture_id), fixture_revision: uuid(row.fixture_revision) };
}
function selection(value) {
    const row = object(value, ['schema', 'project_id', 'environment_id', 'module_id', 'module_binding', 'credentials']);
    if (row.schema !== 'blinkhost.customer-test-credential-selection/v1')
        invalid();
    const binding = object(row.module_binding, ['schema', 'module', 'artifact_sha256', 'runtime_policy_sha256']);
    if (binding.schema !== 'blinkhost.release-test-module-binding/v1' || typeof binding.module !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(binding.module)
        || ![binding.artifact_sha256, binding.runtime_policy_sha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))
        invalid();
    if (!Array.isArray(row.credentials) || !row.credentials.length || row.credentials.length > 32)
        invalid();
    const refs = row.credentials.map(reference);
    if (new Set(refs.map(ref => ref.fixture_id)).size !== refs.length
        || refs.some((ref, i) => i > 0 && String(ref.name) <= String(refs[i - 1].name)))
        invalid();
    return { schema: row.schema, project_id: uuid(row.project_id), environment_id: integer(row.environment_id),
        module_id: uuid(row.module_id), module_binding: { schema: binding.schema, module: binding.module,
            artifact_sha256: binding.artifact_sha256, runtime_policy_sha256: binding.runtime_policy_sha256 }, credentials: refs };
}
// Read a bounded stream without echoing it, saving it, trimming its values or
// accepting private input in arguments. JavaScript strings are not zeroizable.
export function readTestCredentialInput(input = stdin, timeoutMs = 30_000) {
    if (input.isTTY)
        return Promise.reject(new CliError('Pipe test credential JSON through standard input.', EXIT.usage, 'test_credentials_stdin_required'));
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const finish = (error) => {
            clearTimeout(timer);
            input.off('data', data).off('end', end).off('error', failed).off('close', closed);
            input.pause();
            try {
                if (error) {
                    input.destroy();
                    reject(error);
                }
                else
                    resolve(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)));
            }
            catch {
                reject(new CliError('Test credential input must be valid UTF-8 JSON.', EXIT.validation, 'test_credentials_invalid'));
            }
            finally {
                for (const chunk of chunks)
                    chunk.fill(0);
            }
        };
        const failed = () => finish(new CliError('Test credential input could not be read.', EXIT.filesystem, 'test_credentials_input_failed'));
        const closed = () => finish(new CliError('Test credential input closed before completion.', EXIT.filesystem, 'test_credentials_input_failed'));
        const end = () => finish();
        const data = (chunk) => {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > LIMIT) {
                bytes.fill(0);
                finish(new CliError('Test credential JSON must not exceed 64 KiB.', EXIT.validation, 'test_credentials_too_large'));
            }
            else
                chunks.push(bytes);
        };
        const timer = setTimeout(() => finish(new CliError('Test credential input timed out.', EXIT.network, 'test_credentials_input_timeout')), timeoutMs);
        input.on('data', data).once('end', end).once('error', failed).once('close', closed);
    });
}
function document(raw, action) {
    try {
        if (!raw.length || Buffer.byteLength(raw) > LIMIT)
            invalid();
        // Bound parser depth independently of byte size. JSON.parse enforces JSON
        // syntax; the YAML JSON parser detects duplicate (including escaped) keys.
        let depth = 0, quoted = false, escaped = false;
        for (const char of raw) {
            if (quoted) {
                if (escaped)
                    escaped = false;
                else if (char === '\\')
                    escaped = true;
                else if (char === '"')
                    quoted = false;
            }
            else if (char === '"')
                quoted = true;
            else if (char === '{' || char === '[') {
                if (++depth > 12)
                    invalid();
            }
            else if (char === '}' || char === ']')
                depth--;
        }
        const parsed = JSON.parse(raw);
        if (parseDocument(raw, { schema: 'json', uniqueKeys: true }).errors.length)
            invalid();
        const row = object(parsed, action === 'revoke' ? ['selection'] : ['selection', 'values', 'replaces']);
        const selected = selection(row.selection);
        if (action !== 'revoke') {
            const values = object(row.values, selected.credentials.map(ref => String(ref.name)));
            for (const value of Object.values(values)) {
                if (typeof value !== 'string' || value.includes('\0') || Buffer.from(value).toString('utf8') !== value
                    || Buffer.byteLength(value) > 16 * 1024)
                    invalid();
            }
            if (action === 'create') {
                if (row.replaces !== null)
                    invalid();
            }
            else {
                const previous = selection(row.replaces);
                const old = previous.credentials;
                if (JSON.stringify({ ...previous, credentials: [] }) !== JSON.stringify({ ...selected, credentials: [] })
                    || old.length !== selected.credentials.length || old.some((ref, i) => {
                    const next = selected.credentials[i];
                    return ref.fixture_revision === next.fixture_revision
                        || JSON.stringify({ ...ref, fixture_revision: null }) !== JSON.stringify({ ...next, fixture_revision: null });
                }))
                    invalid();
            }
        }
        return { ...row, selection: selected };
    }
    catch {
        invalid();
    }
}
function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
        || !Number.isFinite(Date.parse(value)))
        invalid();
}
function metadata(value, after) {
    const body = object(value, ['fixtures', 'next_after']);
    if (!Array.isArray(body.fixtures) || body.fixtures.length > 100)
        invalid();
    let previous = after || '';
    const fixtures = body.fixtures.map(value => {
        const row = object(value, ['id', 'fixture_id', 'revision', 'name', 'scope', 'version', 'module_name', 'created_at', 'revoked_at']);
        const id = uuid(row.id);
        if (id <= previous || typeof row.module_name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.module_name))
            invalid();
        previous = id;
        reference({ name: row.name, scope: row.scope, version: row.version, fixture_id: row.fixture_id, fixture_revision: row.revision });
        timestamp(row.created_at);
        if (row.revoked_at !== null)
            timestamp(row.revoked_at);
        return row;
    });
    if (body.next_after !== null && (fixtures.length !== 100 || uuid(body.next_after) !== previous))
        invalid();
    return { fixtures, next_after: body.next_after };
}
export async function runTestCredentials(input, profile, source = stdin) {
    const args = [...input];
    const action = args.shift();
    let path, raw, selected, after;
    if (action === 'list') {
        const options = {};
        while (args.length) {
            const flag = args.shift();
            const value = args.shift();
            if (!['--project', '--environment', '--module', '--after'].includes(flag) || !value || options[flag])
                invalid();
            options[flag] = value;
        }
        if (!/^[1-9][0-9]*$/.test(options['--environment'] || ''))
            invalid();
        after = options['--after'] === undefined ? undefined : uuid(options['--after']);
        path = `${BASE}${uuid(options['--project'])}/${integer(Number(options['--environment']))}/${uuid(options['--module'])}/`;
        if (after)
            path += `?after=${after}`;
    }
    else if (['create', 'rotate', 'revoke'].includes(action)) {
        if (args.length !== 1 || args[0] !== '--stdin')
            invalid();
        raw = await readTestCredentialInput(source);
        selected = document(raw, action).selection;
        path = `${BASE}${selected.project_id}/${selected.environment_id}/${selected.module_id}/`;
    }
    else
        invalid();
    try {
        const client = await ApiClient.create(profile);
        const result = await client.request(path, { method: action === 'list' ? 'GET' : action === 'revoke' ? 'DELETE' : 'POST',
            ...(raw === undefined ? {} : { body: raw }) }, LIMIT);
        if (action === 'list')
            return metadata(result, after);
        if (action === 'revoke') {
            if (result !== null)
                invalid();
            return { revoked: true };
        }
        const response = object(result, ['credentials']);
        if (!Array.isArray(response.credentials) || response.credentials.length > 32
            || JSON.stringify(response.credentials.map(reference)) !== JSON.stringify(selected.credentials))
            invalid();
        return { credentials: selected.credentials };
    }
    catch (error) {
        // A server or transport error may contain a reflected value. Do not expose
        // its body, request ID, arbitrary code or exception text, even in JSON mode.
        throw new CliError('Test credential operation could not be confirmed. Check access and list fixture metadata before retrying a write.', error instanceof CliError ? error.exitCode : EXIT.remote, 'test_credentials_unconfirmed');
    }
}
//# sourceMappingURL=test-credentials.js.map