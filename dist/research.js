import { CliError, EXIT } from './errors.js';
// This is a display/selection boundary, not a URL fetcher. The server verifies
// the content digest, review, expiry and allowlist again at admission and claim.
export function validateResearchCatalog(raw, project) {
    const fail = () => { throw new CliError('The public source catalog could not be verified. No research was started.', EXIT.remote, 'research_catalog_invalid'); };
    const text = (value, max, multiline = false) => typeof value === 'string'
        && !!value.trim() && Buffer.byteLength(value) <= max
        && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(multiline ? value.replace(/[\n\t]/g, '') : value);
    const value = raw;
    if (!value || value.project_id !== project.toLowerCase() || value.live_search !== false
        || value.max_selection !== 4 || typeof value.truncated !== 'boolean'
        || !Array.isArray(value.sources) || value.sources.length > 100)
        fail();
    const seen = new Set();
    for (const source of value.sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)
            || Object.keys(source).sort().join(',') !== 'attribution,captured_at,excerpt,expires_at,id,publisher,schema,title,url'
            || source.schema !== 'blinkhost.idam.public-source/v1' || typeof source.id !== 'string'
            || !/^[a-f0-9]{64}$/.test(source.id) || seen.has(source.id)
            || !text(source.title, 300) || !text(source.publisher, 200) || !text(source.attribution, 1000)
            || !text(source.excerpt, 6000, true) || !text(source.url, 1500)
            || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./~%\-]*$/.test(source.url))
            fail();
        let url;
        try {
            url = new URL(source.url);
        }
        catch {
            return fail();
        }
        if (!/\.[a-z]{2,63}$/.test(url.hostname) || /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)
            || url.hostname.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
            || /%(?![0-9a-f]{2})|%(0[0-9a-f]|1[0-9a-f]|7f|25|2f|5c)/i.test(url.pathname))
            fail();
        const captured = typeof source.captured_at === 'string' ? Date.parse(source.captured_at) : NaN;
        const expires = typeof source.expires_at === 'string' ? Date.parse(source.expires_at) : NaN;
        if (!Number.isFinite(captured) || !Number.isFinite(expires) || expires <= captured || expires - captured > 90 * 86400000)
            fail();
        seen.add(source.id);
    }
}
//# sourceMappingURL=research.js.map