import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiClient, publicRequest } from '../api.js';
import { CliError, EXIT } from '../errors.js';
import { parseLogOptions, readLogs, renderLogEntry, serializeLogEvent, sinceFilters, writeLogOutput, type LogClient, type LogEntry } from '../logs.js';

const project = '11111111-2222-4333-8444-555555555555';
const now = Date.parse('2026-10-24T12:00:00Z');
const event = (id: string) => ({ event_id: id, event_time: '2026-10-24T11:59:00Z', severity: 'info', message: 'hello', attributes_json: '{"order":{"id":18446744073709551615}}' });
const batch = (ids: string[], cursor: string | null = null) => ({ events: ids.map(event), has_more: !!cursor, next_cursor: cursor });
const options = (args: string[] = []) => ({ ...parseLogOptions(args, now), project });
function recorder() { const entries: LogEntry[] = []; return { entries, emit: async (entry: LogEntry) => { entries.push(entry); } }; }
async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (origin: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('since durations and timezone-aware calendar instants map to actual API filters', () => {
  for (const [value, ms] of [['1s', 1000], ['5m', 300000], ['2h', 7200000], ['7d', 604800000]] as const) {
    assert.deepEqual(sinceFilters(value, now), { start_time: new Date(now - ms).toISOString() });
  }
  assert.deepEqual(sinceFilters('2026-10-24T12:30:00+01:00', now), { start_time: '2026-10-24T11:30:00.000Z' });
  assert.deepEqual(sinceFilters('1s', now, true), { hours: '1' });
  assert.deepEqual(sinceFilters('61m', now, true), { hours: '2' });
  for (const value of ['0h', '-1h', '367d', '1.5h', '999999999999999999d', 'today', '2026-02-30T00:00:00Z', '2026-10-24T11:00:00', '2026-10-24T11:00:00.1234Z', '2026-10-24T13:00:00Z', '2026-10-24T24:00:00Z']) {
    assert.throws(() => sinceFilters(value, now), { code: 'invalid_log_options' }, value);
  }
  assert.throws(() => sinceFilters('2026-10-24T11:00:00Z', now, true));
});

test('standard, nested custom and preview filters validate without rounding 64-bit input', () => {
  const raw = '[{"path":["order","items",0,"id"],"op":"eq","type":"integer","value":18446744073709551615}]';
  const result = parseLogOptions(['--project', project, '--since', '5m', '--attribute-filters', raw, '--preview-session-id', project,
    '--trace-id', 'A'.repeat(32), '--severity', 'warning', '--event-kind', 'application_log', '--limit', '3'], now);
  assert.equal(result.filters.attribute_filters, raw);
  assert.equal(result.filters.environment_kind, 'preview');
  assert.equal(result.filters.trace_id, 'a'.repeat(32));
  assert.equal(result.filters.limit, '3');
  assert.equal(parseLogOptions(['--environment-id', '18446744073709551615'], now).filters.environment_id, '18446744073709551615');
  for (const args of [['--limit', '201'], ['--follow', '--follow'], ['--cursor', 'x', '--follow'], ['--since', '1h', '--hours', '1'],
    ['--unknown', 'x'], ['--project', 'wrong'], ['--search', 'x'.repeat(161)], ['--environment-id', '-1'], ['--trace-id', 'x'],
    ['--event-kind', 'fake'], ['--since'], ['--environment-kind', 'preview', '--deployment-id', '1'], ['--environment-kind', 'deployed', '--preview-session-id', project],
    ['--start-time', '2026-10-24T11:00:00Z', '--end-time', '2026-10-24T10:00:00Z']]) assert.throws(() => parseLogOptions(args, now), { code: 'invalid_log_options' });
  for (const value of ['18446744073709551616', '-9223372036854775809', '1e3', '1.0']) {
    assert.throws(() => parseLogOptions(['--attribute-filters', raw.replace('18446744073709551615', value)], now));
  }
  for (const raw of ['[]', 'null', '[{"path":["x",1e0],"op":"exists"}]', '[{"path":["x"],"type":"number","op":"eq","value":1e999}]',
    '[{"path":["x"],"type":"number","op":"eq","value":9007199254740993}]']) assert.throws(() => parseLogOptions(['--attribute-filters', raw], now));
});

test('history retains scope and uses the remaining row budget without losing cutoff continuation', async () => {
  const record = recorder(), calls: URL[] = [];
  const client: LogClient = { async request(path, init, limit) {
    const url = new URL(path, 'http://local'); calls.push(url);
    assert.equal(limit, 2 * 1024 * 1024);
    assert.match(new Headers(init?.headers).get('X-Observability-Query-Id')!, /^[0-9a-f-]{36}$/);
    return calls.length === 1 ? batch(['a', 'b'], 'cursor1') : batch(['c'], 'cursor2');
  } };
  await readLogs(client, options(['--limit', '2', '--max-events', '3', '--since', '1h', '--severity', 'info']), record.emit, new AbortController().signal);
  assert.deepEqual(calls.map(c => c.searchParams.get('limit')), ['2', '1']);
  assert.equal(calls[1]!.searchParams.get('cursor'), 'cursor1');
  for (const call of calls) { assert.equal(call.searchParams.get('severity'), 'info'); assert.equal(call.searchParams.get('start_time'), '2026-10-24T11:00:00.000Z'); }
  const summary = record.entries.at(-1)!;
  assert.equal(summary.kind, 'summary');
  if (summary.kind === 'summary') { assert.equal(summary.next_cursor, 'cursor2'); assert.equal(summary.events, 3); assert.equal(summary.reason, 'event limit reached'); assert.match(renderLogEntry(summary, false), /--cursor "cursor2".*--start-time/); }
});

test('typed historical pages send the exact integer JSON and keep cursors in the query string', async () => {
  const raw = '[{"path":["id"],"op":"eq","type":"integer","value":18446744073709551615}]';
  const cursors: (string | null)[] = [];
  await readLogs({ async request(path, init) {
    const url = new URL(path, 'http://local');
    assert.equal(url.pathname, `/api/sites/${project}/observability/logs/search/`);
    const query = url.searchParams;
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, raw);
    assert.equal(query.has('attribute_filters'), false);
    assert.equal(query.get('severity'), 'info');
    cursors.push(query.get('cursor'));
    return cursors.length === 1 ? batch(['a'], 'next') : batch(['b']);
  } }, options(['--attribute-filters', raw, '--severity', 'info', '--limit', '1']), async () => {}, new AbortController().signal);
  assert.deepEqual(cursors, [null, 'next']);
});

test('history rejects cycles, overfull pages, missing cursors and malformed rows', async () => {
  for (const malformed of [batch(['x', 'y', 'z']), { events: [], has_more: true, next_cursor: 'x' }, { events: [{ event_id: 1 }], has_more: false }, { events: [], has_more: 'no' }]) {
    await assert.rejects(readLogs({ request: async () => malformed }, options(['--limit', '2']), async () => {}, new AbortController().signal), { code: 'invalid_log_response' });
  }
  let reads = 0;
  await assert.rejects(readLogs({ request: async () => { reads++; return batch(['x'], reads % 2 ? 'a' : 'b'); } }, options(), async () => {}, new AbortController().signal), { code: 'invalid_log_response' });
  assert.equal(reads, 3);
});

test('historical reads stop at 1000 pages even with repeated IDs and keep their continuation', async () => {
  let reads = 0; const record = recorder();
  await readLogs({ request: async () => batch(['same'], `cursor-${++reads}`) }, options(['--limit', '1', '--max-events', '2000']), record.emit, new AbortController().signal);
  assert.equal(reads, 1000);
  const summary = record.entries.at(-1)!;
  assert.equal(summary.kind, 'summary');
  if (summary.kind === 'summary') { assert.equal(summary.reason, 'page limit reached'); assert.equal(summary.events, 1); assert.equal(summary.duplicates_skipped, 999); assert.equal(summary.next_cursor, 'cursor-1000'); }
});

test('precise NDJSON stays one line and text neutralizes spoofed messages and terminal controls', () => {
  const raw = '{\n "id": 18446744073709551615, "label": "a b\\n c", "control":"\\u001b[31m\\u202E"\n}';
  const item = { ...event('a'), attributes_json: raw, event_time: 'time\nspoof', message: 'first\nspoof\u001b[31m\u202E' };
  const serialized = renderLogEntry({ kind: 'event', event: item }, true);
  assert.equal(serialized.split('\n').length, 2);
  assert.match(serialized, /18446744073709551615/);
  assert.equal(JSON.parse(serialized).event.attributes.label, 'a b\n c');
  assert.ok(!serialized.includes('\u001b') && !serialized.includes('\u202E'));
  const text = renderLogEntry({ kind: 'event', event: item }, false);
  assert.equal(text.split('\n').length, 2); assert.match(text, /\\nspoof/);
  for (const attributes_json of ['{"x":1e999}', '[]', 'not json', '{"x":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}']) {
    const fallback = JSON.parse(serializeLogEvent({ ...event('x'), attributes_json, attributes: { fallback: true } }));
    assert.ok(fallback.precision_notice); assert.deepEqual(fallback.attributes, { fallback: true });
  }
});

test('follow deduplicates reconnect overlap, recovers via cursors, reports gaps and closes ticket', async () => {
  const controller = new AbortController(), record = recorder(), calls: string[] = [], waits: number[] = [];
  let poll = 0, attempt = 0;
  const client: LogClient = { async request(path, init) {
    calls.push(path);
    if (init?.method === 'POST' && path.endsWith('live-tail-tickets/')) {
      assert.match(String(init.body), /18446744073709551615/);
      return { ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() };
    }
    if (init?.method === 'POST' && path.includes('/cancel/')) return { cancelled: true };
    assert.equal(new Headers(init?.headers).get('X-Live-Tail-Ticket'), 'scoped');
    if (init?.method === 'DELETE') return { closed: true };
    if (poll === 1 && attempt++ === 0) throw new CliError('temporary', EXIT.network, 'network_error');
    if (poll === 0) return batch(['a', 'a', 'b']);
    if (poll === 1) return path.includes('cursor=older') ? batch(['a', 'b']) : batch(['c', 'c'], 'older');
    return batch(['d']);
  } };
  const raw = '[{"path":["id"],"op":"eq","type":"integer","value":18446744073709551615}]';
  await readLogs(client, options(['--follow', '--attribute-filters', raw]), record.emit, controller.signal, async ms => {
    waits.push(ms); if (ms === 2500 && ++poll === 3) controller.abort();
  });
  assert.deepEqual(record.entries.filter(e => e.kind === 'event').map(e => e.kind === 'event' && e.event.event_id), ['a', 'b', 'c', 'd']);
  assert.ok(record.entries.some(e => e.kind === 'notice' && e.code === 'follow_interrupted'));
  assert.ok(record.entries.some(e => e.kind === 'notice' && e.code === 'continuity_unconfirmed'));
  assert.deepEqual(waits, [2500, 5000, 2500, 2500]);
  assert.ok(calls.at(-1)!.endsWith('live-tail/'));
  assert.ok(calls.some(c => c.includes('cursor=older')));
  const summary = record.entries.find(e => e.kind === 'summary');
  assert.ok(summary && summary.kind === 'summary'); assert.equal(summary.duplicates_skipped, 2); assert.equal(summary.reason, 'interrupted'); assert.equal(summary.next_cursor, null);
});

test('follow never retries permission expiry and bounds transient attempts to four', async () => {
  for (const code of ['api_403', 'api_429', 'api_503']) {
    let reads = 0, closes = 0, waits = 0;
    const client: LogClient = { async request(path, init) {
      if (init?.method === 'POST') return { ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() };
      if (init?.method === 'DELETE') { closes++; return { closed: true }; }
      reads++; throw new CliError('fixture', code === 'api_403' ? EXIT.auth : EXIT.remote, code);
    } };
    await assert.rejects(readLogs(client, options(['--follow']), async () => {}, new AbortController().signal, async () => { waits++; }), { code });
    assert.equal(reads, code === 'api_403' ? 1 : 4); assert.equal(waits, code === 'api_403' ? 0 : 3); assert.equal(closes, 1);
  }
});

test('follow limits each poll to ten pages and exposes full-window discontinuity', async () => {
  let reads = 0; const record = recorder(), controller = new AbortController();
  await readLogs({ async request(_path, init) {
    if (init?.method === 'POST') return { ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() };
    if (init?.method === 'DELETE') return { closed: true };
    return batch([`e-${++reads}`], `c-${reads}`);
  } }, options(['--follow', '--limit', '1']), record.emit, controller.signal, async () => { controller.abort(); });
  assert.equal(reads, 10);
  assert.ok(record.entries.some(e => e.kind === 'notice' && e.code === 'continuity_unconfirmed'));
});

test('expiry aborts an in-flight follow request, cancels only its owned query and closes ticket', async () => {
  const record = recorder(); let queryId = '', cancel = '', closed = false;
  await readLogs({ async request(path, init) {
    if (path.endsWith('live-tail-tickets/')) return { ticket: 'scoped', expires_at: new Date(Date.now() + 35).toISOString() };
    if (path.includes('/cancel/')) { cancel = path; assert.equal(init?.signal?.aborted, false); return { cancelled: true }; }
    if (init?.method === 'DELETE') { closed = true; return { closed: true }; }
    queryId = new Headers(init?.headers).get('X-Observability-Query-Id')!;
    // A real timer keeps the test alive; AbortSignal.timeout itself is unref'ed.
    await new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('expiry did not abort')), 1000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(guard); reject(new Error('aborted')); }, { once: true });
    });
  } }, options(['--follow']), record.emit, new AbortController().signal);
  assert.equal(cancel, `/api/observability-query-leases/${queryId}/cancel/`); assert.ok(closed);
  assert.ok(record.entries.some(e => e.kind === 'summary' && e.reason === 'live-tail ticket expired'));
});

test('interrupt during a wait is quiet and ticket closure failure is explicit', async () => {
  const record = recorder(), controller = new AbortController();
  await readLogs({ async request(path, init) {
    if (path.endsWith('live-tail-tickets/')) return { ticket: 'scoped', expires_at: new Date(Date.now() + 60000).toISOString() };
    if (init?.method === 'DELETE') throw new CliError('offline', EXIT.network, 'network_error');
    return batch([]);
  } }, options(['--follow']), record.emit, controller.signal, async () => { controller.abort(); throw new Error('interrupted'); });
  assert.ok(record.entries.some(e => e.kind === 'summary' && e.reason === 'interrupted'));
  assert.equal(record.entries.at(-1)?.kind, 'notice');
});

test('malformed and expired ticket responses fail before polling', async () => {
  for (const ticket of [null, {}, { ticket: 'x', expires_at: 'bad' }, { ticket: 'x', expires_at: '2020-01-01T00:00:00Z' }]) {
    let reads = 0;
    await assert.rejects(readLogs({ request: async (_path, init) => { if (init?.method === 'POST') return ticket; if (init?.method === 'GET' || !init?.method) reads++; return {}; } }, options(['--follow']), async () => {}, new AbortController().signal), { code: 'invalid_log_response' });
    assert.equal(reads, 0);
  }
});

test('output backpressure prevents the next page request until the emitted event completes', async () => {
  let reads = 0, release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const completed = readLogs({ request: async () => ++reads === 1 ? batch(['a'], 'c') : batch(['b']) }, options(['--limit', '1']), async entry => { if (entry.kind === 'event' && entry.event.event_id === 'a') await blocked; }, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  release!(); await completed; assert.equal(reads, 2);
});

test('terminal writes await callbacks, stop on interruption and detach listeners after synchronous errors', async () => {
  const controller = new AbortController();
  let complete: ((error?: Error | null) => void) | undefined, done = false;
  const output = { write(_value: string, callback: typeof complete) { complete = callback; return false; } } as Pick<NodeJS.WriteStream, 'write'>;
  const pending = writeLogOutput(output, 'event', controller.signal).then(result => { done = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  complete!(); assert.equal(await pending, true);
  const stalled = writeLogOutput(output, 'event', controller.signal);
  controller.abort(); assert.equal(await stalled, false);
  assert.equal(await writeLogOutput(output, 'ignored', controller.signal), false);
  const fresh = new AbortController(); let removed = 0;
  const original = fresh.signal.removeEventListener.bind(fresh.signal);
  fresh.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => { removed++; original(type, listener, options); };
  await assert.rejects(writeLogOutput({ write() { throw new Error('closed output'); } } as Pick<NodeJS.WriteStream, 'write'>, 'event', fresh.signal), /closed output/);
  assert.equal(removed, 1);
});

test('the historical deadline aborts an in-flight read and independently cancels its query', async t => {
  const original = AbortSignal.timeout.bind(AbortSignal), timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return original(ms === 120_000 ? 35 : ms); });
  let owned = '', cancelled = ''; const record = recorder();
  await readLogs({ async request(path, init) {
    if (path.includes('/cancel/')) { cancelled = path; assert.equal(init?.signal?.aborted, false); return { cancelled: true }; }
    owned = new Headers(init?.headers).get('X-Observability-Query-Id')!;
    await new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('historical deadline did not abort')), 1000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(guard); reject(new Error('deadline')); }, { once: true });
    });
  } }, options(), record.emit, new AbortController().signal);
  assert.equal(cancelled, `/api/observability-query-leases/${owned}/cancel/`);
  assert.deepEqual(timeouts, [120_000, 5000]);
  assert.ok(record.entries.some(e => e.kind === 'summary' && e.reason === 'time limit reached'));
});

test('loopback API uses authentication, exact ticket filters, scoped pagination and bounded bodies', async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  await loopback((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-fixture');
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      calls.push({ url: req.url!, method: req.method!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('live-tail-tickets/')) res.end(JSON.stringify({ ticket: 'ticket', expires_at: new Date(Date.now() + 60000).toISOString() }));
      else if (req.method === 'DELETE') res.end('{"closed":true}');
      else res.end(JSON.stringify(batch(['http-record'])));
    });
  }, async origin => {
    const client = ApiClient.fromAccessToken('fixture', { apiOrigin: origin }, 'local-fixture');
    const record = recorder();
    await readLogs(client, options(['--follow', '--max-events', '1', '--attribute-filters', '[{"path":["id"],"op":"eq","type":"integer","value":18446744073709551615}]']), record.emit, new AbortController().signal);
    assert.equal(record.entries.filter(e => e.kind === 'event').length, 1);
    assert.match(calls[0]!.body, /"value":18446744073709551615/);
    assert.ok(calls[1]!.url.endsWith('live-tail/?limit=1'));
    assert.equal(calls[2]!.method, 'DELETE');
  });
});

test('bounded response readers cancel declared and chunked overflow and reject broken JSON', async () => {
  for (const declared of [true, false]) {
    let cancelled = false; const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '33' } : {}) } });
    try { await assert.rejects(publicRequest('http://127.0.0.1', '/logs', {}, 32), { code: 'response_too_large' }); assert.ok(cancelled); }
    finally { globalThis.fetch = original; }
  }
  await loopback((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{broken'); }, async origin => {
    await assert.rejects(publicRequest(origin, '/', {}, 32), { code: 'invalid_log_response' });
    await assert.rejects(publicRequest(origin, '/', {}, 0), { code: 'invalid_response_limit' });
  });
});
