/** Deterministic customer-owned loopback fixtures. No forwarding or provider credentials. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const BODY_BYTES = 65_536, FIXTURE_BYTES = 1_048_576, EVENT_LIMIT = 256;
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('invalid_local_provider_fixture');
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_local_provider_fixture_limit');
  return value;
}
const controls = /[\x00-\x1f\x7f]/;

export function providerFixtures(value = {}) {
  if (!object(value) || Object.keys(value).length > 8) fail('invalid_local_provider_fixtures');
  const result = {};
  let configuredBytes = 2;
  // Count each copied JSON component before retaining it. Escape-heavy bodies
  // must obey the serialized limit too, without first building the whole tree.
  const account = item => {
    configuredBytes += Buffer.byteLength(JSON.stringify(item)) + 2;
    if (configuredBytes > FIXTURE_BYTES) fail('invalid_local_provider_fixture_limit');
  };
  for (const [name, provider] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) fail('invalid_local_provider_fixture_name');
    account(name); account({ routes: [] });
    keys(provider, ['routes']);
    if (!Array.isArray(provider.routes) || !provider.routes.length || provider.routes.length > 32) fail('invalid_local_provider_fixture_routes');
    const routes = provider.routes.map(route => {
      keys(route, ['method', 'path', 'responses'], ['request_sha256', 'repeat_last']);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
        || typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.startsWith('//')
        || route.path.length > 2048 || /[?#\\]/.test(route.path) || controls.test(route.path)
        || route.path.split('/').some(part => part === '.' || part === '..')) fail('invalid_local_provider_fixture_route');
      if (route.request_sha256 !== undefined && (typeof route.request_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(route.request_sha256))) fail('invalid_local_provider_fixture_request_digest');
      if (route.repeat_last !== undefined && typeof route.repeat_last !== 'boolean') fail('invalid_local_provider_fixture_repeat');
      if (!Array.isArray(route.responses) || !route.responses.length || route.responses.length > 32) fail('invalid_local_provider_fixture_responses');
      account({ method: route.method, path: route.path, responses: [], request_sha256: route.request_sha256,
        repeat_last: route.repeat_last ?? false });
      const responses = route.responses.map(response => {
        keys(response, ['status'], ['headers', 'body', 'chunks', 'delay_ms']);
        integer(response.status, 200, 599);
        if (response.status >= 300 && response.status < 400) fail('local_provider_fixture_redirect_forbidden');
        if (response.body !== undefined && response.chunks !== undefined) fail('invalid_local_provider_fixture_response');
        const headers = response.headers ?? {};
        keys(headers, [], ['content-type', 'retry-after']);
        for (const [key, item] of Object.entries(headers)) {
          if (typeof item !== 'string' || !item || item.length > 256 || controls.test(item)
            || (key === 'retry-after' && !/^[0-9]{1,5}$/.test(item))) fail('invalid_local_provider_fixture_header');
        }
        const delay = integer(response.delay_ms ?? 0, 0, 30_000);
        account({ status: response.status, headers, chunks: [], delay_ms: delay });
        let bodyBytes = 0, elapsed = delay;
        const copyChunk = (body, milliseconds) => {
          if (typeof body !== 'string') fail('invalid_local_provider_fixture_body');
          bodyBytes += Buffer.byteLength(body); elapsed += milliseconds;
          if (bodyBytes > BODY_BYTES || elapsed > 30_000) fail('invalid_local_provider_fixture_limit');
          const chunk = { body, delay_ms: milliseconds };
          account(chunk); return chunk;
        };
        let chunks;
        if (response.chunks !== undefined) {
          if (!Array.isArray(response.chunks) || !response.chunks.length || response.chunks.length > 64) fail('invalid_local_provider_fixture_chunks');
          chunks = response.chunks.map(chunk => {
            keys(chunk, ['body'], ['delay_ms']);
            return copyChunk(chunk.body, integer(chunk.delay_ms ?? 0, 0, 30_000));
          });
        } else {
          if (response.body !== undefined && typeof response.body !== 'string') fail('invalid_local_provider_fixture_body');
          chunks = [copyChunk(response.body ?? '', 0)];
        }
        if ([204, 205, 304].includes(response.status) && chunks.some(chunk => chunk.body)) fail('invalid_local_provider_fixture_response');
        return { status: response.status, headers: { ...headers }, chunks, delay_ms: delay };
      });
      return { method: route.method, path: route.path, responses, request_sha256: route.request_sha256,
        repeat_last: route.repeat_last ?? false };
    });
    if (new Set(routes.map(route => route.method + ' ' + route.path)).size !== routes.length) fail('duplicate_local_provider_fixture_route');
    result[name] = { routes };
  }
  return result;
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('local_provider_fixture_cancelled')); return; }
  const abort = () => { clearTimeout(timer); reject(new Error('local_provider_fixture_cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal.addEventListener('abort', abort, { once: true });
});

export async function startProviderFixture(name, definition) {
  const fixture = providerFixtures({ [name]: definition })[name];
  // Validation above copies the customer definition before any listener starts.
  const routes = fixture.routes.map(route => ({ ...route, consumed: 0, attempts: 0 }));
  let active = 0, stopped = false, stopping, dropped = 0, completed = 0, aborted = 0, rejected = 0;
  const events = [], sockets = new Set(), closingResponses = new Set();
  const record = event => { if (events.length < EVENT_LIMIT) events.push(event); else dropped += 1; };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000,
    headersTimeout: 5000, connectionsCheckingInterval: 250 }, async (request, response) => {
    const address = server.address(), host = `127.0.0.1:${address.port}`;
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    const reply = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }); response.end(body);
    };
    const count = name => request.rawHeaders.filter((_, index) => index % 2 === 0).filter(key => key.toLowerCase() === name).length;
    if (request.socket.remoteAddress !== '127.0.0.1' || count('host') !== 1 || count('origin') > 1
      || request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      reply(403, 'local fixture origin rejected'); return;
    }
    if (stopped || active >= 16) { reply(503, 'local fixture capacity unavailable'); return; }
    const route = routes.find(route => route.method === request.method && route.path === request.url);
    if (!route) { reply(404, 'local fixture route unavailable'); return; }
    active += 1;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    closingResponses.add(closed);
    const controller = new AbortController(); let terminal = false, bodyTimer;
    const event = { route: route.method + ' ' + route.path, response_index: null, request_bytes: 0,
      request_sha256: null, status: null, outcome: 'aborted' };
    response.once('finish', () => {
      terminal = true;
      if (event.outcome === 'completed') completed += 1; else rejected += 1;
    });
    response.once('close', () => {
      clearTimeout(bodyTimer); controller.abort(); active -= 1;
      if (!terminal) aborted += 1;
      record({ ...event });
      closingResponses.delete(closed); resolveClosed();
    });
    request.once('aborted', () => controller.abort());
    bodyTimer = setTimeout(() => { event.status = 408; event.outcome = 'body_timeout'; reply(408, 'local fixture body timed out'); }, 5000);
    try {
      const hash = createHash('sha256');
      for await (const chunk of request) {
        event.request_bytes += chunk.length;
        if (event.request_bytes > BODY_BYTES) { event.status = 413; event.outcome = 'body_limit'; reply(413, 'local fixture body limit exceeded'); return; }
        hash.update(chunk);
      }
      clearTimeout(bodyTimer);
      controller.signal.throwIfAborted();
      event.request_sha256 = hash.digest('hex');
      route.attempts += 1;
      if (route.request_sha256 && event.request_sha256 !== route.request_sha256) {
        event.status = 422; event.outcome = 'request_mismatch'; reply(422, 'local fixture request mismatch'); return;
      }
      const index = route.consumed;
      if (index >= route.responses.length && !route.repeat_last) {
        event.status = 409; event.outcome = 'sequence_exhausted'; reply(409, 'local fixture sequence exhausted'); return;
      }
      // Admission consumes the step even when a client leaves after sending it.
      // A retry does not invent an exactly-once provider side effect.
      route.consumed += 1;
      event.response_index = Math.min(index, route.responses.length - 1);
      const selected = route.responses[event.response_index];
      await delay(selected.delay_ms, controller.signal);
      event.status = selected.status;
      response.writeHead(selected.status, { 'content-type': 'application/json', ...selected.headers });
      for (const chunk of selected.chunks) {
        await delay(chunk.delay_ms, controller.signal);
        if (response.destroyed) return;
        if (!response.write(chunk.body)) {
          await new Promise((resolve, reject) => {
            const abort = () => { response.off('drain', drain); reject(new Error('local_provider_fixture_cancelled')); };
            const drain = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
            controller.signal.addEventListener('abort', abort, { once: true }); response.once('drain', drain);
            if (controller.signal.aborted) abort();
          });
        }
      }
      event.outcome = 'completed'; response.end();
    } catch {
      if (!controller.signal.aborted) { event.status = 400; event.outcome = 'request_failed'; reply(400, 'local fixture request unavailable'); }
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('connection', socket => {
    if (stopped || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const snapshot = () => ({ schema: 'blinkhost.local-provider-fixture/v1', name, origin, active, completed, aborted, rejected,
    dropped_events: dropped, events: events.map(event => ({ ...event })),
    routes: routes.map(route => ({ method: route.method, path: route.path, attempts: route.attempts, consumed: route.consumed })),
    outbound_connections: false, production_authority: false });
  return { origin, snapshot,
    stop: () => {
      if (!stopping) {
        stopped = true;
        const responsesClosed = [...closingResponses];
        const listenerClosed = new Promise(resolve => { server.close(resolve); });
        for (const socket of sockets) socket.destroy();
        stopping = Promise.all([listenerClosed, ...responsesClosed]).then(snapshot);
      }
      return stopping;
    } };
}
