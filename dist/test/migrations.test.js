import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeConfig } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { runMigrations } from '../migrations.js';
import { main } from '../cli.js';
const project = '11111111-1111-4111-8111-111111111111';
const migration = '22222222-2222-4222-8222-222222222222';
const sql = '-- Café\r\nCREATE TABLE orders (id INTEGER);\r\n';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const rootPath = `/api/migrations/projects/${project}/`;
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'blinkhost-migration-'));
    const oldHome = process.env.BLINKHOST_CONFIG_HOME;
    const oldToken = process.env.BLINKHOST_ACCESS_TOKEN;
    const oldFetch = globalThis.fetch;
    process.env.BLINKHOST_CONFIG_HOME = root;
    process.env.BLINKHOST_ACCESS_TOKEN = 'synthetic-migration-access';
    t.after(async () => {
        globalThis.fetch = oldFetch;
        if (oldHome === undefined)
            delete process.env.BLINKHOST_CONFIG_HOME;
        else
            process.env.BLINKHOST_CONFIG_HOME = oldHome;
        if (oldToken === undefined)
            delete process.env.BLINKHOST_ACCESS_TOKEN;
        else
            process.env.BLINKHOST_ACCESS_TOKEN = oldToken;
        await rm(root, { recursive: true, force: true });
    });
    await writeConfig({ activeProfile: 'fixture', profiles: { fixture: { apiOrigin: 'https://api.example.com' } } });
    const path = join(root, 'orders.sql');
    await writeFile(path, sql);
    const common = ['--environment', 'preview', '--version', '12', '--file', path];
    const requests = [];
    const schema = 'CREATE TABLE customers (id INTEGER);';
    const review = {
        project: { id: project, name: 'Customer app' }, migration_id: migration, environment: 'preview', version: 12,
        checksum: hash(sql), sql, identity: { database_id: 'db-id', binding_id: 'binding-id', generation: 'generation-1' },
        before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64),
        schema_sources: { source: hash(schema) }, target_schema_sql: schema,
    };
    const state = {
        workspace: '7', project, token: 'synthetic-review-1', planStatus: 'pending', failPlan: 0,
        failApply: 0, loseApply: false, status: 'pending', phase: 'planned', verification: undefined,
    };
    const reply = () => ({ migration_id: migration, checksum: hash(sql), status: state.status, phase: state.phase,
        ...(state.verification ? { verification: state.verification } : {}) });
    globalThis.fetch = async (url, init) => {
        const req = new Request(url, init);
        requests.push(req);
        const route = new URL(req.url).pathname;
        assert.equal(req.headers.get('authorization'), 'Bearer synthetic-migration-access');
        if (route === `/api/sites/${project}/`)
            return Response.json({ id: state.project, organization: state.workspace });
        assert.equal(req.headers.get('x-organization-id'), state.workspace);
        if (route === rootPath + 'plan/') {
            if (state.failPlan)
                return Response.json({ code: 'migration_content_conflict' }, { status: state.failPlan });
            return Response.json({ migration_id: migration, review, status: state.planStatus, review_token: state.token });
        }
        if (route === rootPath + migration + '/apply/') {
            if (state.loseApply)
                throw new TypeError('Connection lost after request');
            if (state.failApply)
                return Response.json({ code: 'migration_review_expired' }, { status: state.failApply });
            return Response.json({ ...reply(), status: 'applied', phase: 'dispatched', verification: 'fresh_primary_history' });
        }
        assert.equal(route, rootPath + migration + '/status/');
        assert.equal(new URL(req.url).search, '?environment=preview');
        assert.equal(req.method, 'GET');
        return Response.json(reply());
    };
    const plan = async () => {
        const out = await runMigrations(['plan', project, ...common]);
        assert.ok('review_sha256' in out);
        return out;
    };
    const apply = (digest, id = migration) => runMigrations(['apply', project, id, ...common, '--confirm-review', digest]);
    const status = () => runMigrations(['status', project, migration, '--environment', 'preview']);
    const writes = () => requests.filter(req => new URL(req.url).pathname.endsWith('/apply/'));
    return { root, path, state, requests, common, review, plan, apply, status, writes };
}
test('ordinary scoped API reviews exact SQL, keeps tokens private and verifies primary history', async (t) => {
    const f = await fixture(t);
    const plan = await f.plan();
    assert.deepEqual(plan.review, f.review);
    assert.equal(plan.organization_id, '7');
    assert.equal(plan.api_origin, 'https://api.example.com');
    assert.match(plan.review_sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(plan).includes(f.state.token));
    assert.deepEqual(await f.requests.at(-1).clone().json(), { environment: 'preview', version: 12, sql, expected_checksum: hash(sql) });
    assert.equal(f.writes().length, 0);
    f.state.token = 'synthetic-fresh-review';
    const applied = await f.apply(plan.review_sha256);
    assert.deepEqual(applied, { migration_id: migration, status: 'applied', phase: 'dispatched', checksum: hash(sql), verification: 'fresh_primary_history' });
    assert.equal(f.writes().length, 1);
    assert.deepEqual(await f.writes()[0].clone().json(), { environment: 'preview', review_token: f.state.token, confirm: true });
    assert.ok(f.writes()[0].headers.has('idempotency-key'));
    assert.equal((await f.status()).status, 'pending');
    f.state.status = 'applied';
    f.state.phase = 'dispatched';
    f.state.verification = 'fresh_primary_history';
    assert.deepEqual(await f.status(), applied);
});
test('explicit workspace uses only migration APIs for a resource-scoped CLI session', async (t) => {
    const f = await fixture(t);
    const args = [...f.common, '--organization', f.state.workspace];
    const plan = await runMigrations(['plan', project, ...args]);
    assert.ok('review_sha256' in plan);
    await runMigrations(['apply', project, migration, ...args, '--confirm-review', plan.review_sha256]);
    await runMigrations(['status', project, migration, '--environment', 'preview', '--organization', f.state.workspace]);
    assert.equal(f.requests.length, 4);
    assert.ok(f.requests.every(req => new URL(req.url).pathname.startsWith(rootPath)));
    await assert.rejects(runMigrations(['plan', project, ...f.common, '--organization', '-1']), CliError);
    assert.equal(f.requests.length, 4);
});
test('changed workspace, project name, generation, hashes, sources, schema, migration ID or phase cannot apply', async (t) => {
    const f = await fixture(t);
    const { review_sha256: digest } = await f.plan();
    const changed = (err) => err instanceof CliError && err.code === 'migration_review_changed';
    for (const [object, key, replacement] of [
        [f.state, 'workspace', '8'], [f.review.project, 'name', 'Renamed'], [f.review.identity, 'generation', 'gen-2'],
        [f.review, 'before_sha256', 'f'.repeat(64)], [f.review, 'after_sha256', '0'.repeat(64)],
        [f.review, 'schema_sources', {}], [f.review, 'target_schema_sql', ''], [f.state, 'planStatus', 'applied'],
    ]) {
        const prior = object[key];
        object[key] = replacement;
        await assert.rejects(f.apply(digest), changed);
        object[key] = prior;
    }
    await assert.rejects(f.apply(digest, project), changed);
    await assert.rejects(f.apply('0'.repeat(64)), changed);
    assert.equal(f.writes().length, 0);
});
test('malformed, unreviewed or wrong-target API data is rejected before apply', async (t) => {
    const f = await fixture(t);
    const { review_sha256 } = await f.plan();
    const bad = (e) => e instanceof CliError && e.code === 'invalid_migration_response';
    for (const [key, value] of [['checksum', hash('different')], ['sql', 'other'], ['version', 50], ['environment', 'production'],
        ['migration_id', project], ['added_review_term', true], ['identity', {}], ['schema_sources', { file: 'invalid' }]]) {
        const review = f.review;
        const prior = review[key];
        review[key] = value;
        await assert.rejects(f.apply(review_sha256), bad);
        if (prior === undefined)
            delete review[key];
        else
            review[key] = prior;
    }
    f.state.token = '';
    await assert.rejects(f.plan(), bad);
    f.state.token = 'synthetic-token';
    f.state.status = 'applied';
    await assert.rejects(f.status(), bad);
    f.state.project = migration;
    await assert.rejects(f.plan(), (e) => e instanceof CliError && e.code === 'project_workspace_unavailable');
    assert.equal(f.writes().length, 0);
});
test('input limits, explicit environment and exact confirmation are checked before authentication', async (t) => {
    const f = await fixture(t);
    for (const args of [
        ['plan', project], ['status', 'not-id'], ['status', project, migration, '--environment', 'pr'],
        ['status', project, migration, ...f.common], ['plan', project, ...f.common, '--environment', 'production'],
        ['plan', project, ...f.common, '--unknown', 'a'], ['apply', project, migration, ...f.common],
        ['apply', project, migration, ...f.common, '--confirm-review', 'yes'], ['plan', project, ...f.common, '--confirm-review', '0'.repeat(64)],
        ['plan', project, '--environment', 'preview', '--version', '10001', '--file', f.path],
    ])
        await assert.rejects(runMigrations(args), (e) => e instanceof CliError && e.code === 'invalid_migration_input');
    for (const bytes of [Buffer.alloc(16385, 65), Buffer.from([255]), Buffer.from('  '), Buffer.from('a\0b')]) {
        await writeFile(f.path, bytes);
        await assert.rejects(f.plan(), (e) => e instanceof CliError && e.code === 'invalid_migration_input');
    }
    assert.equal(f.requests.length, 0);
});
test('remote denials, review expiry and lost apply responses never produce a successful or repeated write', async (t) => {
    const f = await fixture(t);
    for (const status of [403, 409, 503]) {
        f.state.failPlan = status;
        await assert.rejects(f.plan(), (e) => e instanceof CliError && e.code === 'api_' + status);
    }
    f.state.failPlan = 0;
    const { review_sha256 } = await f.plan();
    f.state.failApply = 409;
    await assert.rejects(f.apply(review_sha256), (e) => e instanceof CliError && e.exitCode === EXIT.conflict && e.details.some(d => d.includes('migrations status')));
    assert.equal(f.writes().length, 1);
    f.state.loseApply = true;
    await assert.rejects(f.apply(review_sha256), (e) => e instanceof CliError && e.exitCode === EXIT.network && e.details.some(d => d.includes(migration)));
    assert.equal(f.writes().length, 2);
});
test('normal CLI JSON, human help and shell automation expose only the reviewed public data', async (t) => {
    const f = await fixture(t);
    const chunks = [];
    t.mock.method(process.stdout, 'write', (text) => { chunks.push(text); return true; });
    assert.equal(await main(['migrations', 'plan', project, ...f.common, '--json']), EXIT.success);
    let output = JSON.parse(chunks.join(''));
    assert.equal(output.data.review.sql, sql);
    assert.ok(!chunks.join('').includes(f.state.token));
    chunks.length = 0;
    assert.equal(await main(['help', 'migrations']), EXIT.success);
    assert.match(chunks.join(''), /--confirm-review SHA256/);
    chunks.length = 0;
    assert.equal(await main(['migrations', 'status', project, migration, '--environment', 'preview', '--json']), EXIT.success);
    output = JSON.parse(chunks.join(''));
    assert.equal(output.data.status, 'pending');
});
//# sourceMappingURL=migrations.test.js.map