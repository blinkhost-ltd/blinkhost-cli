import { CliError, EXIT } from './errors.js';
const codes = new Set(['node_server', 'native_dependency', 'persistent_connections',
    'framework_server_features', 'python_server', 'python_native_dependency', 'manifest_not_inspected', 'manifest_incomplete']);
const sections = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'requirements']);
const count = (value, max) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// Bind remote evidence to this project and known declaration-only semantics.
// This validates output, never resolves packages or runs local code.
export function validateCompatibility(value, projectId) {
    if (!object(value) || value.project_id !== projectId || value.schema_version !== 1 || (value.rules_version !== 1 && value.rules_version !== 2)
        || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
        || value.verification !== 'declaration_review_only' || value.backend_runtime !== 'wasm'
        || !count(value.findings_omitted, 8000) || !Array.isArray(value.findings) || value.findings.length > 128
        || value.findings.some(f => !object(f) || typeof f.code !== 'string' || !codes.has(f.code)
            || typeof f.path !== 'string' || !f.path || Buffer.byteLength(f.path) > 8447 || /[\x00-\x1f]/.test(f.path)
            || (f.package !== null && (typeof f.package !== 'string' || f.package.length > 202))
            || !Array.isArray(f.sections) || f.sections.length > 4 || new Set(f.sections).size !== f.sections.length
            || f.sections.some(s => typeof s !== 'string' || !sections.has(s))
            || (f.code.startsWith('python_')
                ? value.rules_version !== 2 || f.sections.length !== 1 || f.sections[0] !== 'requirements'
                : f.sections.includes('requirements'))
            || (f.code.startsWith('manifest_') ? f.package !== null || f.sections.length !== 0 : !f.package || !f.sections.length))
        || !object(value.coverage) || !count(value.coverage.projected_files, 2000) || !count(value.coverage.package_manifests, 2000)
        || Number(value.coverage.package_manifests) > Number(value.coverage.projected_files)
        || !count(value.coverage.inspected_package_manifests, 32)
        || Number(value.coverage.inspected_package_manifests) > Number(value.coverage.package_manifests)
        || typeof value.coverage.projection_limit_reached !== 'boolean'
        || !Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > 10
        || value.limitations.some(note => typeof note !== 'string' || note.length > 2048)) {
        throw new CliError('The project review could not be verified. No compatibility or runtime support can be inferred. Review blinkhost docs ai.', EXIT.remote, 'compatibility_response_invalid');
    }
}
//# sourceMappingURL=compatibility.js.map