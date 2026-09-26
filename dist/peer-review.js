import { CliError, EXIT } from './errors.js';
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.exec(v)?.[0] === v;
const date = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
export function validatePeerResponse(value, expected, action) {
    const fail = () => { throw new CliError('The peer review response could not be verified. Refresh peer-options or peer-review before another action; never retry automatically.', EXIT.remote, 'peer_response_invalid'); };
    if (!object(value))
        return fail();
    const peer = (v, source, bind) => {
        if (!object(v) || !keys(v, ['id', 'project_id', 'reviewer_id', 'review_digest', 'expires_at', 'approved_at', 'declined_at', 'revoked_at', 'verification', ...(source ? ['diffs'] : [])])
            || !uuid(v.id) || v.project_id !== expected.project || !Number.isSafeInteger(v.reviewer_id) || Number(v.reviewer_id) < 1
            || typeof v.review_digest !== 'string' || /^[a-f0-9]{64}$/.exec(v.review_digest)?.[0] !== v.review_digest
            || !date(v.expires_at) || [v.approved_at, v.declined_at, v.revoked_at].some(d => d !== null && !date(d))
            || (v.approved_at && v.declined_at) || v.verification !== 'source_review_only'
            || (bind && ((expected.peer && v.id !== expected.peer) || (expected.reviewer && v.reviewer_id !== expected.reviewer)
                || (expected.digest && v.review_digest !== expected.digest))))
            return fail();
        if (source && (!Array.isArray(v.diffs) || !v.diffs.length || v.diffs.length > 20
            || v.diffs.some(d => !object(d) || !keys(d, ['path', 'diff']) || typeof d.path !== 'string' || !d.path
                || typeof d.diff !== 'string') || new Set(v.diffs.map(d => d.path)).size !== v.diffs.length))
            return fail();
    };
    if (action === 'peer-withdraw') {
        if (!keys(value, ['id', 'revoked_at']) || value.id !== expected.peer || !date(value.revoked_at))
            return fail();
    }
    else if (action === 'peer-options') {
        if (!keys(value, ['project_id', 'task_id', 'truncated', 'required', 'reviewers', 'active']) || value.project_id !== expected.project
            || value.task_id !== expected.task || typeof value.truncated !== 'boolean' || typeof value.required !== 'boolean'
            || !Array.isArray(value.reviewers) || value.reviewers.length > 100
            || value.reviewers.some(r => !object(r) || !keys(r, ['id', 'name', 'role']) || !Number.isSafeInteger(r.id)
                || Number(r.id) < 1 || typeof r.name !== 'string' || !['owner', 'admin'].includes(String(r.role)))
            || new Set(value.reviewers.map(r => r.id)).size !== value.reviewers.length)
            return fail();
        if (value.active !== null)
            peer(value.active, false, false);
    }
    else if (action === 'peer-inbox') {
        if (!keys(value, ['project_id', 'truncated', 'reviews']) || value.project_id !== expected.project
            || typeof value.truncated !== 'boolean' || !Array.isArray(value.reviews) || value.reviews.length > 100)
            return fail();
        for (const item of value.reviews)
            peer(item, false, false);
        if (new Set(value.reviews.map(r => r.id)).size !== value.reviews.length)
            return fail();
    }
    else {
        peer(value, action !== 'peer-invite', true);
        if ((action === 'peer-approve' && (!value.approved_at || value.revoked_at))
            || (action === 'peer-decline' && (!value.declined_at || value.revoked_at)))
            return fail();
    }
}
//# sourceMappingURL=peer-review.js.map