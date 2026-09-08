import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssistant } from '../assistant.js';
import { validateModuleBuild } from '../module-build.js';
import { documentationTopic } from '../guidance.js';
const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const review = '597a2b2d-53cb-4396-a021-9be4de0f1af0';
const module = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const receipt = { id: review, project_id: project, module_id: module, revision: digest,
    source_digest: digest, action_digest: digest, expires_at: '2026-09-07T20:00:00Z',
    applied_at: '2026-09-07T19:45:00Z', build_id: module, build_state: 'requested', artifact_id: null,
    usage: { metric: 'preview_builds', quantity: 1, ai_units: 0, policy: 'standard_build_allowance_and_configured_overages' },
    verification: 'build_requested_not_published' };
test('build catalog rejects ambiguous or terminal-control metadata', () => {
    const entry = { id: module, name: 'api', language: 'typescript-wasi', build_available: true };
    const catalog = { project_id: project, revision: digest, modules: [entry] };
    validateModuleBuild(catalog, { project }, 'build-modules');
    for (const changed of [{ name: 'api\n' }, { language: 'typescript-wasi\n' },
        { name: '\u001b[31mapi' }, { id: `${module}\n` }, { build_available: 'true' }]) {
        assert.throws(() => validateModuleBuild({ ...catalog, modules: [{ ...entry, ...changed }] }, { project }, 'build-modules'));
    }
    assert.throws(() => validateModuleBuild({ ...catalog, modules: [entry, entry] }, { project }, 'build-modules'));
});
test('catalog and review commands preserve source revision and stable request ID without building', async () => {
    const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    const requests = [];
    const prepared = { ...receipt, applied_at: null, build_id: null, build_state: null, verification: 'not_applied' };
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
        return new Response(JSON.stringify(init?.method === 'POST' ? prepared : {
            project_id: project, revision: digest, modules: [{ id: module, name: 'api', language: 'typescript-wasi', build_available: true }],
        }), { headers: { 'content-type': 'application/json' } });
    };
    try {
        await runAssistant(['build-modules', '--project', project]);
        await runAssistant(['build-review', '--project', project, '--module', module, '--revision', digest, '--request-id', review]);
        assert.equal(requests.length, 2);
        assert.equal(requests[0]?.method, 'GET');
        assert.equal(requests[1]?.method, 'POST');
        assert.ok(requests[1]?.url.endsWith(`/projects/${project}/module-builds/review/`));
        assert.deepEqual(JSON.parse(String(requests[1]?.body)), { module_id: module, revision: digest, client_request_id: review });
    }
    finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
    }
});
test('build approval requires exact confirmation and rejects bypass options before network', async () => {
    const base = ['build-approve', review, '--project', project, '--digest', digest];
    for (const args of [base, [...base, '--confirm', project], [...base, '--confirm', review, '--force'],
        [...base, '--confirm', review, '--publish'], ['build-review', '--project', project, '--module', module]]) {
        await assert.rejects(runAssistant(args));
    }
    assert.ok(documentationTopic('ai')?.usage.some(line => line.includes('ai build-approve')));
});
test('build responses reject changed scope, charges and unknown state', () => {
    const expected = { project, review, digest };
    validateModuleBuild(receipt, expected, 'build-approve');
    for (const changed of [{ project_id: module }, { id: project }, { action_digest: 'b'.repeat(64) },
        { build_state: 'deployed' }, { usage: { ...receipt.usage, quantity: 2 } },
        { applied_at: null, verification: 'not_applied', build_id: null, build_state: null }]) {
        assert.throws(() => validateModuleBuild({ ...receipt, ...changed }, expected, 'build-approve'), /could not be verified/);
    }
    validateModuleBuild({ ...receipt, build_id: null, build_state: null }, expected, 'build-status');
    for (const state of ['provisioning', 'signing', 'succeeded', 'failed_platform', 'failed_user', 'failed_security', 'rejected']) {
        validateModuleBuild({ ...receipt, build_state: state }, expected, 'build-status');
    }
});
test('build CLI sends one exact approval and reads status without replay', async () => {
    const originalToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
        return new Response(JSON.stringify(receipt), { headers: { 'content-type': 'application/json' } });
    };
    try {
        const args = ['build-approve', review, '--project', project, '--digest', digest, '--confirm', review];
        const result = await runAssistant(args);
        assert.match(result.message, /not published/);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.method, 'POST');
        assert.ok(requests[0]?.url.endsWith(`/projects/${project}/module-builds/reviews/${review}/apply/`));
        assert.deepEqual(JSON.parse(String(requests[0]?.body)), { action_digest: digest });
        await runAssistant(['build-status', review, '--project', project]);
        assert.equal(requests[1]?.method, 'GET');
        let attempts = 0;
        globalThis.fetch = async () => { attempts++; throw new Error('synthetic lost response'); };
        await assert.rejects(runAssistant(args));
        assert.equal(attempts, 1);
    }
    finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = originalToken;
    }
});
//# sourceMappingURL=module-build.test.js.map