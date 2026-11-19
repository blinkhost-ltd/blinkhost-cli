import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const project = '11111111-2222-4333-8444-555555555555';
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const row = (id, message = 'fixture') => ({ event_id: id, event_time: new Date().toISOString(), severity: 'info', message, attributes_json: '{"id":18446744073709551615}' });
async function fixture(handler, run) {
    const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'blinkhost-cli-process-'));
    const server = createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer local-fixture');
        res.setHeader('content-type', 'application/json');
        handler(req, res);
    });
    const children = [];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        await writeFile(join(root, 'config.json'), JSON.stringify({ activeProfile: 'fixture', profiles: { fixture: { apiOrigin: `http://127.0.0.1:${address.port}` } }, updateNotifications: true }));
        await run((args, drain = true) => {
            const child = spawn(process.execPath, [cli, '--json', '--non-interactive', 'logs', '--project', project, ...args], {
                cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', BLINKHOST_CONFIG_HOME: root, BLINKHOST_ACCESS_TOKEN: 'local-fixture' }, stdio: 'pipe',
            });
            children.push(child);
            if (drain)
                child.stdout.resume();
            child.stderr.resume();
            return child;
        });
    }
    finally {
        for (const child of children)
            if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL');
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true }); // Only the temporary fixture created above.
    }
}
function exit(child) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not terminate within six seconds')); }, 6000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
}
test('the real command emits precise NDJSON, stops at its event bound and skips update checks', async () => {
    const calls = [];
    let closed = false;
    await fixture((req, res) => {
        calls.push(req.url);
        if (req.method === 'POST')
            res.end(JSON.stringify({ ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() }));
        else if (req.method === 'DELETE') {
            closed = true;
            res.end('{"closed":true}');
        }
        else
            res.end(JSON.stringify({ events: [row('one')], has_more: false, next_cursor: null }));
    }, async (launch) => {
        const child = launch(['--follow', '--max-events', '1']);
        let output = '', errors = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { errors += data; });
        assert.deepEqual(await exit(child), { code: 0, signal: null });
        assert.equal(errors, '');
        assert.ok(closed);
        assert.equal(calls.length, 3);
        const lines = output.trim().split('\n');
        assert.equal(lines.length, 3);
        assert.match(lines[1], /18446744073709551615/);
        assert.equal(JSON.parse(lines[2]).reason, 'event limit reached');
    });
});
test('SIGINT and SIGTERM abort in-flight HTTP, cancel only the owned query and close the ticket', async () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        let child, owned = '', cancelled = '', closed = false;
        await fixture((req, res) => {
            if (req.method === 'DELETE') {
                closed = true;
                res.end('{"closed":true}');
            }
            else if (req.url.includes('/cancel/')) {
                cancelled = req.url;
                res.end('{"cancelled":true}');
            }
            else if (req.method === 'POST')
                res.end(JSON.stringify({ ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() }));
            else {
                owned = String(req.headers['x-observability-query-id']);
                child.kill(signal); /* Leave this read in flight. */
            }
        }, async (launch) => {
            child = launch(['--follow']);
            let output = '';
            child.stdout.on('data', data => { output += data; });
            assert.deepEqual(await exit(child), { code, signal: null });
            assert.equal(cancelled, `/api/observability-query-leases/${owned}/cancel/`);
            assert.ok(closed);
            assert.ok(output.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.reason === 'interrupted'));
        });
    }
});
test('interrupting a blocked stdout pipe exits promptly and still releases the live ticket', async () => {
    let child, closed = false, reads = 0;
    await fixture((req, res) => {
        if (req.method === 'POST')
            res.end(JSON.stringify({ ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() }));
        else if (req.method === 'DELETE') {
            closed = true;
            res.end('{"closed":true}');
        }
        else {
            reads++;
            res.end(JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => row(String(i), 'x'.repeat(1600))), has_more: true, next_cursor: 'older' }));
            setTimeout(() => child.kill('SIGINT'), 200);
        }
    }, async (launch) => {
        child = launch(['--follow', '--limit', '200'], false);
        assert.deepEqual(await exit(child), { code: 130, signal: null });
        assert.ok(closed);
        assert.equal(reads, 1);
        child.stdout.destroy();
    });
});
test('a closed stdout consumer stops polling and closes its ticket without uncaught stream errors', async () => {
    let child, closed = false;
    await fixture((req, res) => {
        if (req.method === 'POST')
            res.end(JSON.stringify({ ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() }));
        else if (req.method === 'DELETE') {
            closed = true;
            res.end('{"closed":true}');
        }
        else {
            child.stdout.destroy();
            res.end(JSON.stringify({ events: [row('one')], has_more: false, next_cursor: null }));
        }
    }, async (launch) => {
        child = launch(['--follow']);
        let errors = '';
        child.stderr.on('data', data => { errors += data; });
        const result = await exit(child);
        assert.equal(result.signal, null);
        assert.notEqual(result.code, 0);
        assert.ok(closed);
        assert.ok(!errors.includes('Unhandled') && !errors.includes('unhandled'));
    });
});
test('live ticket expiry also releases a command blocked on stdout without requiring a signal', async () => {
    let closed = false, reads = 0;
    await fixture((req, res) => {
        if (req.method === 'POST')
            res.end(JSON.stringify({ ticket: 'scoped', expires_at: new Date(Date.now() + 300).toISOString() }));
        else if (req.method === 'DELETE') {
            closed = true;
            res.end('{"closed":true}');
        }
        else {
            reads++;
            res.end(JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => row(String(i), 'x'.repeat(1600))), has_more: true, next_cursor: 'older' }));
        }
    }, async (launch) => {
        const child = launch(['--follow', '--limit', '200'], false);
        assert.deepEqual(await exit(child), { code: 0, signal: null });
        assert.ok(closed);
        assert.equal(reads, 1);
        child.stdout.destroy();
    });
});
//# sourceMappingURL=logs_process.test.js.map