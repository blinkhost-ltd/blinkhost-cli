import { CliError, EXIT } from './errors.js';
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const hash = (value) => matches(/^[a-f0-9]{64}$/, value);
const uuid = (value) => matches(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const starterName = (value) => matches(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, value);
export const starterLanguage = (value) => matches(/^[a-z]{1,24}-wasi$/, value);
export function validateStarter(value, expected, action) {
    const fail = () => { throw new CliError('The starter response could not be verified. Use starter-status with the existing review ID before any further approval. Do not retry a save automatically.', EXIT.remote, 'starter_response_invalid'); };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail();
    const item = value;
    if (item.project_id !== expected.project || !hash(item.revision))
        return fail();
    if (action === 'starters') {
        if (item.verification !== 'starter_only' || !Array.isArray(item.languages) || item.languages.length > 20
            || item.languages.some((entry) => !entry || !starterLanguage(entry.id)
                || typeof entry.label !== 'string' || !entry.label || entry.label.length > 80
                || /[\x00-\x1f\x7f-\x9f]/.test(entry.label) || !['ga', 'beta'].includes(entry.status))
            || new Set(item.languages.map((entry) => entry.id)).size !== item.languages.length)
            return fail();
        return;
    }
    if (!uuid(item.id) || !starterName(item.name) || !starterLanguage(item.language)
        || !hash(item.action_digest) || !date(item.expires_at) || typeof item.template_current !== 'boolean'
        || (expected.review !== undefined && item.id !== expected.review)
        || (expected.name !== undefined && item.name !== expected.name)
        || (expected.language !== undefined && item.language !== expected.language)
        || (expected.revision !== undefined && item.revision !== expected.revision)
        || (expected.digest !== undefined && item.action_digest !== expected.digest)
        || !Array.isArray(item.files) || item.files.length > 20
        || (item.template_current ? item.files.length === 0 : item.files.length !== 0)
        || item.files.some((file) => !file || typeof file.path !== 'string'
            || !file.path.startsWith(`_server_islands/${item.name}/`) || file.path.length > 512
            || file.path.split('/').some((part) => !part || part === '.' || part === '..')
            || /[\\:\x00-\x1f\x7f-\x9f]/.test(file.path) || typeof file.content !== 'string'
            || Buffer.byteLength(file.content, 'utf8') > 65536 || typeof file.managed !== 'boolean')
        || new Set(item.files.map((file) => file.path.toLowerCase())).size !== item.files.length
        || (item.module_id !== null && !uuid(item.module_id))
        || (item.applied_at === null ? item.verification !== 'not_applied' || item.module_id !== null || item.applied_revision !== ''
            : !date(item.applied_at) || item.verification !== 'source_saved_not_built' || !hash(item.applied_revision))
        || (action === 'starter-approve' && !item.applied_at))
        return fail();
}
//# sourceMappingURL=starter.js.map