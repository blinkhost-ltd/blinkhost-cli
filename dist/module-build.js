import { CliError, EXIT } from './errors.js';
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.exec(value)?.[0] === value;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.exec(value)?.[0] === value;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const states = ['requested', 'queued', 'provisioning', 'compiling', 'validating', 'signing',
    'succeeded', 'rejected', 'failed_user', 'failed_security', 'failed_platform', 'cancelled'];
export function validateModuleBuild(value, expected, action) {
    const fail = () => { throw new CliError('The build response could not be verified. Inspect build-status for the existing review before any further approval; never retry automatically.', EXIT.remote, 'build_response_invalid'); };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail();
    const item = value;
    if (item.project_id !== expected.project || !hash(item.revision))
        return fail();
    if (action === 'build-modules') {
        if (!Array.isArray(item.modules) || item.modules.length > 1000 || item.modules.some(module => !module
            || !uuid(module.id) || typeof module.name !== 'string' || /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.exec(module.name)?.[0] !== module.name
            || typeof module.language !== 'string' || /^[a-z]{1,24}-wasi$/.exec(module.language)?.[0] !== module.language
            || typeof module.build_available !== 'boolean')
            || new Set(item.modules.map(module => module.id)).size !== item.modules.length)
            return fail();
        return;
    }
    const usage = item.usage;
    if (!uuid(item.id) || !uuid(item.module_id) || !hash(item.source_digest) || !hash(item.action_digest)
        || !date(item.expires_at) || (expected.review && item.id !== expected.review)
        || (expected.module && item.module_id !== expected.module) || (expected.revision && item.revision !== expected.revision)
        || (expected.digest && item.action_digest !== expected.digest) || !usage || usage.metric !== 'preview_builds'
        || usage.quantity !== 1 || usage.ai_units !== 0 || usage.policy !== 'standard_build_allowance_and_configured_overages'
        || (item.build_id !== null && !uuid(item.build_id)) || (item.artifact_id !== null && !uuid(item.artifact_id))
        || (item.build_state !== null && !states.includes(String(item.build_state)))
        || (item.build_id === null ? item.build_state !== null || item.artifact_id !== null : item.build_state === null)
        || (item.applied_at === null ? item.verification !== 'not_applied' || item.build_id !== null
            : !date(item.applied_at) || item.verification !== 'build_requested_not_published')
        || (action === 'build-approve' && !item.applied_at))
        return fail();
}
//# sourceMappingURL=module-build.js.map