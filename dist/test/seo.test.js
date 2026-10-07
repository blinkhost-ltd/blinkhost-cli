import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkLocalHtml, localAudit, runSeo } from '../seo.js';
import { ApiClient } from '../api.js';
import { EXIT } from '../errors.js';
const good = '<title>Docs</title><meta name="description" content="Useful docs"><link rel="canonical" href="https://example.com/docs">';
test('local findings use stable keys and explicitly untrusted evidence', () => {
    assert.deepEqual(checkLocalHtml(good, '/docs', 'docs.html'), []);
    const a = checkLocalHtml('', '/docs', 'docs.html'), b = checkLocalHtml('<h1>Updated</h1>', '/docs', 'docs.html');
    assert.deepEqual(a.map(f => f.key), b.map(f => f.key));
    assert.ok(a.every(f => f.content_is_untrusted && f.key.length === 64));
});
test('local audit excludes reordered noindex, private, hidden paths and symlinks; empty coverage fails closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-test-'));
    try {
        await writeFile(join(dir, 'index.html'), '<meta content="NOINDEX,follow" name = "robots">');
        await writeFile(join(dir, 'private.html'), '<meta content=private name="blinkhost:visibility">');
        await mkdir(join(dir, '.hidden'));
        await writeFile(join(dir, '.hidden', 'index.html'), '');
        await symlink(join(dir, '.hidden'), join(dir, 'linked'));
        const skipped = await localAudit(dir, true);
        assert.equal(skipped.coverage.files, 0);
        assert.equal(skipped.gate.passed, false);
        await writeFile(join(dir, 'docs.html'), good);
        const result = await localAudit(dir, true);
        assert.equal(result.coverage.files, 1);
        assert.equal(result.gate.passed, true);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('hosted argument validation happens before auth or network', async () => {
    const original = ApiClient.create;
    let calls = 0;
    ApiClient.create = async () => { calls++; throw new Error('unexpected auth'); };
    try {
        for (const args of [['audit', '-'.repeat(36)], ['audit', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '--pages', '0'], ['remediate', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']]) {
            await assert.rejects(runSeo(args), error => error instanceof Error && error.message !== 'unexpected auth');
        }
        assert.equal(calls, 0);
    }
    finally {
        ApiClient.create = original;
    }
});
test('hosted tasks retain bounds, selected model and idempotency', async () => {
    const original = ApiClient.create, calls = [];
    ApiClient.create = async () => ({ request: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { status: 'queued' }; } });
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', audit = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
        await runSeo(['audit', project, '--pages', '5', '--browser-pages', '1', '--gate', '--changed', '--baseline', audit]);
        assert.equal(calls[0].body.page_limit, 5);
        assert.equal(calls[0].body.gate, true);
        assert.equal(calls[0].body.scope, 'changed');
        assert.equal(calls[0].body.baseline_id, audit);
        assert.match(String(calls[0].body.client_request_id), /^[a-f0-9-]{36}$/);
        await runSeo(['remediate', project, audit, '--model', 'customer-model', '--max-units', '12', '--findings', 'a'.repeat(64)]);
        assert.equal(calls[1].body.model, 'customer-model');
        assert.equal(calls[1].body.maximum_units, 12);
    }
    finally {
        ApiClient.create = original;
    }
});
test('CLI help and local gates work through the distributable entry point', async () => {
    const cli = join(process.cwd(), 'dist', 'cli.js');
    const help = spawnSync(process.execPath, [cli, 'seo', '--help', '--json'], { encoding: 'utf8' });
    assert.equal(help.status, EXIT.success);
    assert.equal(help.stderr, '');
    assert.equal(JSON.parse(help.stdout).data.topic.name, 'seo');
    const dir = await mkdtemp(join(tmpdir(), 'seo-cli-gate-'));
    try {
        for (const [html, exit] of [['', EXIT.validation], [good, EXIT.success]]) {
            await writeFile(join(dir, 'index.html'), html);
            const result = spawnSync(process.execPath, [cli, 'seo', 'local', dir, '--gate', '--json'], { encoding: 'utf8' });
            assert.equal(result.status, exit);
            assert.equal(result.stderr, '');
            const payload = JSON.parse(result.stdout);
            assert.equal(payload.data.coverage.files, 1);
            assert.equal(payload.data.gate.passed, exit === EXIT.success);
        }
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('documentation search and experiments preserve explicit request identity, scope and model', async () => {
    const original = ApiClient.create, calls = [];
    ApiClient.create = async () => ({ request: async (path, options) => { calls.push({ path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) : undefined }); return { status: 'queued' }; } });
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dir = await mkdtemp(join(tmpdir(), 'seo-submissions-'));
    try {
        const file = join(dir, 'request.json');
        const search = { client_request_id: identity, query: 'Authentication', locale: 'en-US', count: 5 };
        await writeFile(file, JSON.stringify(search));
        await runSeo(['content-search', project, file]);
        await runSeo(['content-search', project, file]);
        assert.deepEqual(calls[0], calls[1]);
        assert.deepEqual(calls[0].body, search);
        await runSeo(['content-result', project, identity]);
        assert.equal(calls[2].path, `/api/seo/projects/${project}/content/search/${identity}/`);
        const sample = { client_request_id: identity, model: 'customer-model', maximum_units: 200, question: 'Auth?', paths: ['/docs/'], required_facts: ['bearer token'] };
        await writeFile(file, JSON.stringify(sample));
        await runSeo(['sample', project, file]);
        assert.deepEqual(calls[3].body, sample);
        await runSeo(['sample-result', project, identity]);
        assert.equal(calls[4].path, `/api/seo/projects/${project}/samples/${identity}/`);
        await runSeo(['content-delete', project]);
        assert.equal(calls[5].method, 'DELETE');
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test('invalid or oversized experiment files are rejected before auth and network', async () => {
    const original = ApiClient.create;
    let calls = 0;
    ApiClient.create = async () => { calls++; throw new Error('unexpected auth'); };
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dir = await mkdtemp(join(tmpdir(), 'seo-invalid-submissions-'));
    try {
        const file = join(dir, 'request.json');
        const valid = { client_request_id: identity, model: 'chosen', maximum_units: 200, question: 'Auth?', paths: ['/docs/'], required_facts: [] };
        for (const body of [{ ...valid, paths: ['/%2e%2e/private'] }, { ...valid, paths: ['/docs%20here'] }, { ...valid, paths: ['/docs\u007f'] }, { ...valid, required_facts: ['🌍'.repeat(76)] }, { ...valid, question: '🌍'.repeat(251) }, { ...valid, maximum_units: 0 }, { ...valid, client_request_id: undefined }, { ...valid, provider_url: 'https://attacker.invalid' }, []]) {
            await writeFile(file, JSON.stringify(body));
            await assert.rejects(runSeo(['sample', project, file]), error => error instanceof Error && error.message !== 'unexpected auth');
        }
        await writeFile(file, ' '.repeat(100001));
        await assert.rejects(runSeo(['sample', project, file]));
        await writeFile(file, JSON.stringify(valid));
        await symlink(file, join(dir, 'linked.json'));
        await assert.rejects(runSeo(['sample', project, join(dir, 'linked.json')]));
        assert.equal(calls, 0);
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test('native owner exports retain exact CSV or base64 ZIP and provenance', async () => {
    const original = ApiClient.create, calls = [];
    ApiClient.create = async () => ({ request: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { status: 'imported' }; } });
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', dir = await mkdtemp(join(tmpdir(), 'seo-native-'));
    try {
        const metadata = join(dir, 'provenance.json'), file = join(dir, 'export');
        const provenance = { provider: 'google-search', surface: 'organic search', property: 'https://example.com/', timezone: 'UTC', start: '2026-10-01', end: '2026-10-03', aggregation: 'export-total', dimensions: ['path', 'date'], source: 'owner export' };
        await writeFile(metadata, JSON.stringify(provenance));
        const csv = 'Top pages,Clicks,Impressions\nhttps://example.com/docs,2,10\n';
        await writeFile(file, csv);
        await runSeo(['import-native', project, 'google-search-console-csv', file, metadata]);
        assert.deepEqual(calls.at(-1), { path: `/api/seo/projects/${project}/imports/`, body: { version: 'blinkhost-seo/v1', native_format: 'google-search-console-csv', provenance, content: csv } });
        const zip = Buffer.from([80, 75, 3, 4, 0, 255]);
        await writeFile(file, zip);
        await runSeo(['import-native', project, 'google-search-console-zip', file, metadata]);
        assert.equal(calls.at(-1).body.content, zip.toString('base64'));
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test('native import rejects invalid encoding, oversize and unsafe files before auth', async () => {
    const original = ApiClient.create;
    let calls = 0;
    ApiClient.create = async () => { calls++; throw Error('unexpected auth'); };
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', dir = await mkdtemp(join(tmpdir(), 'seo-native-invalid-'));
    try {
        const metadata = join(dir, 'provenance.json'), file = join(dir, 'export');
        await writeFile(metadata, '{}');
        for (const bytes of [Buffer.from([255]), Buffer.alloc(1_450_001)]) {
            await writeFile(file, bytes);
            await assert.rejects(runSeo(['import-native', project, 'bing-webmaster-csv', file, metadata]), error => error instanceof Error && error.message !== 'unexpected auth');
        }
        await writeFile(file, 'Pages,Clicks\n');
        await symlink(file, join(dir, 'link'));
        await assert.rejects(runSeo(['import-native', project, 'bing-webmaster-csv', join(dir, 'link'), metadata]));
        await assert.rejects(runSeo(['import-native', project, 'bing-webmaster-csv', dir, metadata]));
        await writeFile(metadata, ' '.repeat(10001));
        await assert.rejects(runSeo(['import-native', project, 'bing-webmaster-csv', file, metadata]));
        assert.equal(calls, 0);
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test('public research keeps consent, selected model, wallet limits and replay identity', async () => {
    const original = ApiClient.create, calls = [];
    ApiClient.create = async () => ({ request: async (path, options) => {
            calls.push({ path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) : undefined });
            return { status: 'queued' };
        } });
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dir = await mkdtemp(join(tmpdir(), 'seo-public-research-'));
    try {
        const file = join(dir, 'request.json');
        const body = { client_request_id: identity, model: 'permitted-model', maximum_units: 100, query: 'public API documentation', max_reads: 2, public_query_consent: true };
        await writeFile(file, JSON.stringify(body));
        await runSeo(['research', project, file]);
        await runSeo(['research', project, file]);
        assert.deepEqual(calls[0], calls[1]);
        assert.deepEqual(calls[0].body, body);
        assert.equal(calls[0].path, `/api/seo/projects/${project}/research/`);
        await runSeo(['research-status', project]);
        await runSeo(['research-result', project, identity]);
        await runSeo(['research-cancel', project, identity]);
        assert.equal(calls[2].method, 'GET');
        assert.equal(calls[3].path, `/api/seo/projects/${project}/research/${identity}/`);
        assert.equal(calls[4].method, 'DELETE');
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test('public research rejects absent consent and unsafe or excessive queries before auth', async () => {
    const original = ApiClient.create;
    let authCalls = 0;
    ApiClient.create = async () => { authCalls++; throw Error('unexpected auth'); };
    const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', identity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dir = await mkdtemp(join(tmpdir(), 'seo-research-invalid-'));
    try {
        const file = join(dir, 'request.json');
        const valid = { client_request_id: identity, model: 'chosen', maximum_units: 100, query: 'public documentation', max_reads: 1, public_query_consent: true };
        for (const change of [{ public_query_consent: false }, { public_query_consent: undefined }, { query: ' public query' }, { query: '🌍'.repeat(129) }, { query: 'public\u200bquery' }, { max_reads: 6 }, { maximum_units: 0 }, { provider_url: 'https://invalid' }]) {
            await writeFile(file, JSON.stringify({ ...valid, ...change }));
            await assert.rejects(runSeo(['research', project, file]), error => error instanceof Error && error.message !== 'unexpected auth');
        }
        assert.equal(authCalls, 0);
    }
    finally {
        ApiClient.create = original;
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=seo.test.js.map