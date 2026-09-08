import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAssistantRequest, readProjectGuidance, readWorkflowPlan, runAssistant } from '../assistant.js';
import { CliError } from '../errors.js';
import { validateCompatibility } from '../compatibility.js';
import { validateResearchCatalog } from '../research.js';
import { documentationTopic, TOP_LEVEL_COMMANDS } from '../guidance.js';
const task = '597a2b2d-53cb-4396-a021-9be4de0f1af0';
const project = '6097e651-6ce2-4bc7-a28e-fd4f3fa0a353';
const actionDigest = 'a'.repeat(64);
const request = { project_id: project, client_request_id: task, prompt: 'Plan a synthetic app', maximum_units: 100 };
test('resume needs exact confirmation and rejects spending or force overrides', async () => {
    for (const args of [['resume', task], ['resume', task, '--confirm', project],
        ['resume', task, '--confirm', task, '--force'],
        ['resume', task, '--confirm', task, '--maximum-units', '2000']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
    assert.ok(documentationTopic('ai')?.usage.some(line => line.includes('ai resume')));
});
test('resume sends one empty scoped request and verifies checkpoint response', async () => {
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    let calls = 0;
    const value = { task: { id: task, status: 'running', maximum_units: 100 }, continuation: 'requested' };
    globalThis.fetch = async (url, init) => {
        calls += 1;
        assert.ok(String(url).endsWith(`/api/idam/tasks/${task}/resume/`));
        assert.equal(init?.method, 'POST');
        assert.equal(init?.body, '{}');
        return new Response(JSON.stringify(value), { status: 202, headers: { 'content-type': 'application/json' } });
    };
    try {
        const response = await runAssistant(['resume', task, '--confirm', task]);
        assert.deepEqual(response.data, value);
        assert.match(response.message, /original credit limit/);
        assert.equal(calls, 1);
        for (const change of [{ task: { ...value.task, id: project } }, { task: { ...value.task, status: 'cancelled' } },
            { task: { ...value.task, maximum_units: null } }, { continuation: 'restarted' }, { task: null }]) {
            globalThis.fetch = async () => new Response(JSON.stringify({ ...value, ...change }), { status: 202, headers: { 'content-type': 'application/json' } });
            await assert.rejects(runAssistant(['resume', task, '--confirm', task]), /could not be verified/);
        }
        globalThis.fetch = async () => new Response(JSON.stringify({ ...value, continuation: 'already_scheduled' }), { status: 202, headers: { 'content-type': 'application/json' } });
        assert.match((await runAssistant(['resume', task, '--confirm', task])).message, /No additional work was queued/);
        calls = 0;
        globalThis.fetch = async () => { calls += 1; throw new Error('synthetic response loss'); };
        await assert.rejects(runAssistant(['resume', task, '--confirm', task]), CliError);
        assert.equal(calls, 1);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
function publicSource() {
    return { id: actionDigest, schema: 'blinkhost.idam.public-source/v1', title: 'Synthetic source',
        publisher: 'Test publisher', url: 'https://docs.example.com/runtime/wasm',
        excerpt: '<img src=x onerror=alert(1)> Untrusted source.', attribution: 'Synthetic fixture.',
        captured_at: '2026-09-06T12:00:00Z', expires_at: '2026-09-13T12:00:00Z' };
}
test('research requests accept bounded catalog IDs only and never documents or fetch URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-research-'));
    const file = join(root, 'request.json');
    const valid = { ...request, mode: 'research', research_source_ids: [actionDigest] };
    await writeFile(file, JSON.stringify(valid));
    assert.deepEqual(await readAssistantRequest(`@${file}`), valid);
    for (const change of [{ mode: 'build' }, { research_source_ids: [actionDigest, actionDigest] },
        { research_source_ids: 'a' }, { research_source_ids: [null] }, { research_source_ids: ['A'.repeat(64)] },
        { research_source_ids: [1, 2, 3, 4, 5].map(n => String(n).repeat(64)) },
        { research_source_ids: ['https://docs.example.com/a'] }, { documents: [publicSource()] }]) {
        await writeFile(file, JSON.stringify({ ...valid, ...change }));
        await assert.rejects(readAssistantRequest(`@${file}`), CliError);
    }
});
test('source catalog validates project, safe links, bounded text and snapshot-only status', () => {
    const source = publicSource();
    const value = { project_id: project, live_search: false, truncated: false, max_selection: 4, sources: [source] };
    validateResearchCatalog(value, project);
    for (const change of [{ project_id: task }, { live_search: true }, { max_selection: 50 },
        { sources: [source, source] }, { sources: Array(101).fill(source) }, { sources: null }]) {
        assert.throws(() => validateResearchCatalog({ ...value, ...change }, project), CliError);
    }
    for (const change of [{ url: 'javascript:alert(1)' }, { url: 'https://127.0.0.1/a' },
        { url: 'https://docs.example.com/%0a' }, { url: 'https://docs.example.com:443/a' },
        { title: 'x\u001b[2J' }, { excerpt: '🌍'.repeat(1501) }, { expires_at: source.captured_at },
        { expires_at: '2027-01-01T00:00:00Z' }, { private: 'must not print' }, { id: 'forged' }]) {
        assert.throws(() => validateResearchCatalog({ ...value, sources: [{ ...source, ...change }] }, project), CliError);
    }
});
test('source catalog is one control-plane read with no remote website access or upload', async () => {
    for (const args of [['sources'], ['sources', '--project', '../other'],
        ['sources', '--project', project, '--url', 'https://docs.example.com/a']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    const value = { project_id: project, live_search: false, truncated: false, max_selection: 4, sources: [publicSource()] };
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls += 1;
        assert.ok(String(url).endsWith(`/api/idam/projects/${project}/research-sources/`));
        assert.equal(init?.method, undefined);
        assert.equal(init?.body, undefined);
        return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const result = await runAssistant(['sources', '--project', project]);
        assert.deepEqual(result.data, value);
        assert.match(result.message, /not a live search/);
        assert.equal(calls, 1);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
test('compatibility output retains qualified findings and enforces VFS and inspection bounds', () => {
    const finding = { code: 'native_dependency', path: Array(32).fill('x'.repeat(255)).join('/') + '/package.json', package: 'sharp', sections: ['devDependencies'] };
    const result = { project_id: project, schema_version: 1, rules_version: 1, revision: actionDigest,
        verification: 'declaration_review_only', backend_runtime: 'wasm', findings: [finding], findings_omitted: 0,
        coverage: { projected_files: 2, package_manifests: 1, inspected_package_manifests: 1, projection_limit_reached: false },
        limitations: ['Not execution-tested.'] };
    validateCompatibility(result, project);
    for (const change of [{ path: '🌍'.repeat(2112) }, { path: 'x\u001b[2J' }, { code: 'constructor' },
        { sections: ['devDependencies', 'devDependencies'] }, { sections: [] }, { package: null },
        { code: 'manifest_incomplete' }, { sections: ['unknown'] }]) {
        assert.throws(() => validateCompatibility({ ...result, findings: [{ ...finding, ...change }] }, project), CliError);
    }
    validateCompatibility({ ...result, findings: [{ code: 'manifest_incomplete', path: 'package.json', package: null, sections: [] }] }, project);
    for (const change of [{ findings: Array(129).fill(finding) }, { findings_omitted: -1 },
        { limitations: ['x'.repeat(2049)] }, { coverage: { ...result.coverage, projection_limit_reached: 'false' } }]) {
        assert.throws(() => validateCompatibility({ ...result, ...change }, project), CliError);
    }
});
test('Python compatibility requires version two and Python-only declaration sections', () => {
    const finding = { code: 'python_server', path: 'backend/requirements.txt', package: 'django', sections: ['requirements'] };
    const result = { project_id: project, schema_version: 1, rules_version: 2, revision: actionDigest,
        verification: 'declaration_review_only', backend_runtime: 'wasm', findings: [finding], findings_omitted: 0,
        coverage: { projected_files: 1, package_manifests: 1, inspected_package_manifests: 1, projection_limit_reached: false },
        limitations: ['Declarations are not a runtime test.'] };
    validateCompatibility(result, project);
    validateCompatibility({ ...result, findings: [{ ...finding, code: 'python_native_dependency', package: 'numpy' }] }, project);
    assert.throws(() => validateCompatibility({ ...result, rules_version: 1 }, project), CliError);
    for (const change of [{ sections: ['dependencies'] }, { sections: ['requirements', 'devDependencies'] },
        { code: 'node_server' }, { package: null }]) {
        assert.throws(() => validateCompatibility({ ...result, findings: [{ ...finding, ...change }] }, project), CliError);
    }
});
test('compatibility is a scoped read with explicit unknowns and no upload or execution', async () => {
    for (const args of [['compatibility'], ['compatibility', '--project', '../other'],
        ['compatibility', '--project', project, '--file', '@private.json']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    const result = { project_id: project, schema_version: 1, rules_version: 1, revision: actionDigest,
        verification: 'declaration_review_only', backend_runtime: 'wasm', findings: [], findings_omitted: 0,
        coverage: { projected_files: 0, package_manifests: 0, inspected_package_manifests: 0, projection_limit_reached: false },
        limitations: ['No findings is not a compatibility pass.'] };
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls += 1;
        assert.ok(String(url).endsWith(`/api/idam/projects/${project}/compatibility/`));
        assert.equal(init?.method, undefined);
        assert.equal(init?.body, undefined);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const response = await runAssistant(['compatibility', '--project', project.toUpperCase()]);
        assert.deepEqual(response.data, result);
        assert.match(response.message, /not a compatibility pass/);
        assert.equal(calls, 1);
        for (const change of [{ project_id: task }, { schema_version: 2 }, { rules_version: 3 },
            { revision: 'invalid' }, { verification: 'verified' }, { backend_runtime: 'native' },
            { coverage: { ...result.coverage, inspected_package_manifests: 1 } }, { limitations: [] },
            { findings: [{ code: 'execute', path: 'script', package: null, sections: [] }] }]) {
            globalThis.fetch = async () => new Response(JSON.stringify({ ...result, ...change }), { status: 200, headers: { 'content-type': 'application/json' } });
            await assert.rejects(runAssistant(['compatibility', '--project', project]), /could not be verified/);
        }
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
test('guidance accepts only bounded regular UTF-8 files, never inline text or symbolic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-guidance-'));
    const file = join(root, 'guidance.txt');
    await writeFile(file, '🌍'.repeat(1024));
    assert.equal(await readProjectGuidance(`@${file}`), '🌍'.repeat(1024));
    for (const content of ['x'.repeat(4097), '🌍'.repeat(1025), '', '  ', '\u0000unsafe', Buffer.from([0xc3, 0x28])]) {
        await writeFile(file, content);
        await assert.rejects(readProjectGuidance(`@${file}`), CliError);
    }
    await assert.rejects(readProjectGuidance('inline guidance'), CliError);
    await assert.rejects(readProjectGuidance(`@${root}`), CliError);
    if (process.platform !== 'win32') {
        const link = join(root, 'link.txt');
        await symlink(file, link);
        await assert.rejects(readProjectGuidance(`@${link}`), CliError);
    }
});
test('guidance writes require version review and exact project confirmation before authentication', async () => {
    for (const args of [['memory-save'], ['memory-show', '--project', '../other'],
        ['memory-show', '--project', project, '--file', '@private.txt'],
        ['memory-clear', '--project', project],
        ['memory-clear', '--project', project, '--expected-version', '1', '--confirm', task],
        ['memory-save', '--project', project, '--expected-version', '0', '--confirm', project],
        ...['-1', '1.2', 'true', '01', '9007199254740991'].map(v => ['memory-clear', '--project', project, '--expected-version', v, '--confirm', project]),
        ['memory-clear', '--project', project, '--expected-version', '1', '--confirm', project, '--force']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
});
test('guidance uses scoped control-plane GET/PUT with explicit version and never retries writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-guidance-send-'));
    const file = join(root, 'guidance.txt');
    await writeFile(file, 'Prefer accessible forms.');
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    const calls = [];
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify({ project_id: project, version: body ? body.expected_version + 1 : 1,
            content: body ? body.content : 'Prefer accessible forms.', max_bytes: 4096,
            updated_at: '2026-09-06T12:00:00Z',
            trust: 'untrusted_user_guidance', visibility: 'requester_private' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        await runAssistant(['memory-show', '--project', project]);
        await runAssistant(['memory-save', '--project', project, '--expected-version', '0', '--file', `@${file}`, '--confirm', project]);
        await runAssistant(['memory-clear', '--project', project, '--expected-version', '1', '--confirm', project]);
        assert.equal(calls.length, 3);
        assert.ok(calls.every(call => call.url.endsWith(`/api/idam/projects/${project}/memory/`)));
        assert.equal(calls[0].init.method, undefined);
        assert.equal(calls[1].init.method, 'PUT');
        assert.deepEqual(JSON.parse(String(calls[1].init.body)), { expected_version: 0, content: 'Prefer accessible forms.' });
        assert.equal(calls[2].init.method, 'PUT');
        assert.deepEqual(JSON.parse(String(calls[2].init.body)), { expected_version: 1, content: '' });
        for (const result of [{ project_id: task, version: 1, content: 'foreign guidance' },
            { project_id: project, version: 1, content: '', max_bytes: 4096, trust: 'system', visibility: 'requester_private' }]) {
            globalThis.fetch = async () => new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
            await assert.rejects(runAssistant(['memory-show', '--project', project]), /could not be verified/);
        }
        let attempts = 0;
        globalThis.fetch = async () => { attempts += 1; throw new Error('Timeout after possible save'); };
        await assert.rejects(runAssistant(['memory-clear', '--project', project, '--expected-version', '1', '--confirm', project]), CliError);
        assert.equal(attempts, 1);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
test('AI request file is explicit, bounded and has a stable caller request ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-request-'));
    const file = join(root, 'request.json');
    await writeFile(file, JSON.stringify(request));
    assert.deepEqual(await readAssistantRequest(`@${file}`), request);
    for (const bad of [{ ...request, client_request_id: undefined }, { ...request, maximum_units: true },
        { ...request, maximum_units: 2001 }, { ...request, prompt: '' }, { ...request, admin: true }]) {
        await writeFile(file, JSON.stringify(bad));
        await assert.rejects(readAssistantRequest(`@${file}`), CliError);
    }
    await writeFile(file, ' '.repeat(16385));
    await assert.rejects(readAssistantRequest(`@${file}`), CliError);
    await assert.rejects(readAssistantRequest('{"prompt":"inline"}'), CliError);
    await assert.rejects(readAssistantRequest(`@${root}`), CliError);
    if (process.platform !== 'win32') {
        const link = join(root, 'link.json');
        await symlink(file, link);
        await assert.rejects(readAssistantRequest(`@${link}`), CliError);
    }
});
test('approve and cancel require exact confirmations before authentication', async () => {
    for (const args of [['approve', task], ['approve', task, '--confirm', project, '--digest', actionDigest],
        ['approve', task, '--confirm', task], ['cancel', task], ['status', '../../internal'], ['resume', task],
        ['status', task, '--admin']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
});
test('source undo requires a fresh digest and exact confirmation; no force or selection bypass', async () => {
    for (const args of [['rollback-approve', task], ['rollback-approve', task, '--confirm', project, '--digest', actionDigest],
        ['rollback-approve', task, '--confirm', task], ['rollback-approve', task, '--confirm', task, '--digest', 'not-a-digest'],
        ['rollback-approve', task, '--confirm', task, '--digest', actionDigest, '--force'],
        ['rollback-review', task, '--path', 'src/a.ts'], ['rollback-review', '../../internal']]) {
        await assert.rejects(runAssistant(args), CliError);
    }
});
test('source sharing is explicit and bounded; local file contents are never read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-source-'));
    const file = join(root, 'request.json');
    const selected = { ...request, source_paths: ['src/remote-only.ts', 'src/App.tsx'] };
    await writeFile(file, JSON.stringify(selected));
    assert.deepEqual(await readAssistantRequest(`@${file}`), selected);
    for (const paths of ['src/main.ts', ['../private.ts'], ['/private.ts'], ['a', 'a'],
        Array.from({ length: 9 }, (_, i) => `${i}.ts`), [null], ['a\\b.ts'], ['a\u0000.ts']]) {
        await writeFile(file, JSON.stringify({ ...request, source_paths: paths }));
        await assert.rejects(readAssistantRequest(`@${file}`), CliError);
    }
});
test('assistant dispatch uses only the control plane, does not retry, and binds approval digest', async () => {
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ id: task, action_digest: actionDigest, events: [{ kind: 'queued' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        await runAssistant(['approve', task, '--digest', actionDigest, '--confirm', task]);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, new RegExp(`/api/idam/tasks/${task}/apply/$`));
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), { action_digest: actionDigest });
        const events = await runAssistant(['events', task]);
        assert.deepEqual(events.data, [{ kind: 'queued' }]);
        await runAssistant(['review', task, '--path', 'src/a.ts']);
        assert.deepEqual(JSON.parse(String(calls[2].init.body)), { paths: ['src/a.ts'] });
        await runAssistant(['export', task]);
        assert.match(calls[3].url, new RegExp(`/api/idam/tasks/${task}/export/$`));
        assert.equal(calls[3].init.method, undefined);
        await runAssistant(['export', task, '--include-source']);
        assert.match(calls[4].url, /\/export\/\?include_source=1$/);
        assert.equal(calls[4].init.body, undefined);
        await assert.rejects(runAssistant(['export', task, '--include-source', '--include-source']), CliError);
        assert.equal(calls.length, 5);
        await runAssistant(['rollback-review', task]);
        assert.match(calls[5].url, new RegExp(`/api/idam/tasks/${task}/rollback/review/$`));
        assert.equal(calls[5].init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[5].init.body)), {});
        await runAssistant(['rollback-approve', task, '--digest', actionDigest, '--confirm', task]);
        assert.match(calls[6].url, new RegExp(`/api/idam/tasks/${task}/rollback/apply/$`));
        assert.deepEqual(JSON.parse(String(calls[6].init.body)), { action_digest: actionDigest });
        let failures = 0;
        globalThis.fetch = async () => { failures += 1; throw new Error('synthetic timeout'); };
        await assert.rejects(runAssistant(['cancel', task, '--confirm', task]), CliError);
        assert.equal(failures, 1);
        await assert.rejects(runAssistant(['rollback-approve', task, '--digest', actionDigest, '--confirm', task]), CliError);
        assert.equal(failures, 2);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
test('offline installed documentation distinguishes source save from deploy', () => {
    assert.ok(TOP_LEVEL_COMMANDS.includes('ai'));
    const topic = documentationTopic('ai');
    assert.match(JSON.stringify(topic), /staff preview/);
    assert.match(JSON.stringify(topic), /cannot browse, run tests or deploy/);
    assert.match(JSON.stringify(topic), /ai:approve/);
    assert.match(JSON.stringify(topic), /client_request_id/);
    assert.match(JSON.stringify(topic), /workflow-start/);
    assert.match(JSON.stringify(topic), /original cap plus 160/);
});
test('workflow commands require exact confirmation and bounded explicit total before authentication', async () => {
    for (const args of [['workflow-start', task], ['workflow-cancel', task],
        ['workflow-start', task, '--confirm', project, '--maximum-units', '260'],
        ['workflow-start', task, '--confirm', task],
        ...['160', '2001', '1e3', '260.0', 'true', '-1'].map(value => ['workflow-start', task, '--confirm', task, '--maximum-units', value]),
        ['workflow-start', task, '--confirm', task, '--maximum-units', '260', '--force'],
        ['workflow-status', '../../other'], ['workflow-status', task, '--confirm', task]]) {
        await assert.rejects(runAssistant(args), CliError);
    }
});
test('plan files reject unsafe files, unsupported steps and unbounded or extra authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-plan-'));
    const file = join(root, 'plan.json');
    const plan = { steps: [{ mode: 'review', model: 'gpt-5.6-luna', maximum_units: 80 }], maximum_units: 180, maximum_context_units: 200000 };
    await writeFile(file, JSON.stringify(plan));
    assert.deepEqual(await readWorkflowPlan(`@${file}`), plan);
    if (process.platform !== 'win32') {
        const link = join(root, 'link.json');
        await symlink(file, link);
        await assert.rejects(readWorkflowPlan(`@${link}`), CliError);
    }
    await assert.rejects(readWorkflowPlan(`@${root}`), CliError);
    await assert.rejects(readWorkflowPlan('inline'), CliError);
    for (const change of [{ steps: [] }, { steps: plan.steps.concat(plan.steps, plan.steps, plan.steps) },
        { steps: [{ ...plan.steps[0], mode: 'build' }] }, { steps: [{ ...plan.steps[0], model: 'unapproved' }] },
        { steps: [{ ...plan.steps[0], tool: 'execute' }] }, { steps: [{ ...plan.steps[0], maximum_units: true }] },
        { maximum_units: 80 }, { maximum_units: 2001 }, { maximum_units: 1.5 },
        { maximum_context_units: 393217 }, { maximum_context_units: true }, { approve: true }]) {
        await writeFile(file, JSON.stringify({ ...plan, ...change }));
        await assert.rejects(readWorkflowPlan(`@${file}`), CliError);
    }
    for (const invalid of ['x'.repeat(16385), '[]', '{}', Buffer.from([0xc3, 0x28])]) {
        await writeFile(file, invalid);
        await assert.rejects(readWorkflowPlan(`@${file}`), CliError);
    }
});
test('plan edits and approvals need exact saved revision, digest and workflow confirmation', async () => {
    for (const action of ['workflow-revise', 'workflow-approve']) {
        for (const flags of [[], ['--expected-revision', '1'], ['--digest', actionDigest],
            ...['0', '01', '101', 'true', '1.0', '-1'].map(value => ['--expected-revision', value, '--digest', actionDigest]),
            ['--expected-revision', '1', '--digest', '../invalid'],
            ['--expected-revision', '1', '--digest', actionDigest, '--force']]) {
            await assert.rejects(runAssistant([action, task, '--confirm', task, ...flags]), CliError);
        }
        await assert.rejects(runAssistant([action, task, '--confirm', project, '--expected-revision', '1', '--digest', actionDigest]), CliError);
    }
});
test('plan revision and approval use separate scoped writes with no timeout retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'idam-cli-plan-send-'));
    const file = join(root, 'plan.json');
    const plan = { steps: [{ mode: 'review', model: 'gpt-5.6-luna', maximum_units: 80 }], maximum_units: 180, maximum_context_units: 200000 };
    await writeFile(file, JSON.stringify(plan));
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const binding = ['--expected-revision', '2', '--digest', actionDigest, '--confirm', task];
    try {
        const revised = await runAssistant(['workflow-revise', task, ...binding, '--request', `@${file}`]);
        assert.match(revised.message, /draft saved/);
        assert.match(calls[0].url, new RegExp(`/api/idam/workflows/${task}/$`));
        assert.equal(calls[0].init.method, 'PATCH');
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ...plan, expected_revision: 2, plan_digest: actionDigest });
        await runAssistant(['workflow-approve', task, ...binding]);
        assert.match(calls[1].url, new RegExp(`/api/idam/workflows/${task}/approve/$`));
        assert.equal(calls[1].init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[1].init.body)), { expected_revision: 2, plan_digest: actionDigest });
        let attempts = 0;
        globalThis.fetch = async () => { attempts++; throw new Error('Synthetic timeout'); };
        await assert.rejects(runAssistant(['workflow-approve', task, ...binding]), CliError);
        assert.equal(attempts, 1);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
test('workflow commands use scoped control-plane routes and do not repeat writes after timeout', async () => {
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-not-a-real-token';
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ id: project, status: 'active' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
        const saved = await runAssistant(['workflow-plan', task, '--maximum-units', '260', '--confirm', task]);
        assert.match(saved.message, /not approved/);
        assert.match(calls[0].url, new RegExp(`/api/idam/tasks/${task}/workflow/$`));
        assert.equal(calls[0].init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
            steps: [{ mode: 'diagnose', model: 'gpt-5.6-luna', maximum_units: 80 },
                { mode: 'review', model: 'gpt-5.6-luna', maximum_units: 80 }], maximum_units: 260, maximum_context_units: 200000,
        });
        await runAssistant(['workflow-status', project]);
        assert.match(calls[1].url, new RegExp(`/api/idam/workflows/${project}/$`));
        assert.equal(calls[1].init.method, undefined);
        await runAssistant(['workflow-cancel', project, '--confirm', project]);
        assert.match(calls[2].url, new RegExp(`/api/idam/workflows/${project}/cancel/$`));
        assert.deepEqual(JSON.parse(String(calls[2].init.body)), {});
        let attempts = 0;
        globalThis.fetch = async () => { attempts++; throw new Error('Synthetic timeout'); };
        await assert.rejects(runAssistant(['workflow-start', task, '--maximum-units', '260', '--confirm', task]), CliError);
        assert.equal(attempts, 1);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
    }
});
//# sourceMappingURL=assistant.test.js.map