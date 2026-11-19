/** Static customer-local frontend with an owner-selected loopback WASM origin. */
import { createServer, request as requestHttp } from 'node:http';
import { isIP } from 'node:net';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASELINE_REQUEST_BYTES, BASELINE_RESPONSE_BYTES } from '../javascript-runtime/resource-limits.js';

const loopback = value => isIP(value) === 4 ? value.split('.')[0] === '127' : value === '::1';
const addressHost = url => url.hostname.replace(/^\[|\]$/g, '');
const countHeader = (request, name) => request.rawHeaders.filter((_, index) => index % 2 === 0)
  .filter(key => key.toLowerCase() === name).length;

export function localOrigin(value, allowZeroPort = false) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !loopback(addressHost(url)) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || (!allowZeroPort && url.port === '0')) {
    throw new Error('Use an HTTP loopback IP origin without credentials, path, query or fragment.');
  }
  return url;
}

export function options(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index], value = arguments_[index + 1];
    if (!['--frontend', '--runtime-url', '--listen'].includes(key) || !value || values.has(key)) {
      throw new Error('Expected --frontend DIRECTORY --runtime-url HTTP_LOOPBACK_ORIGIN [--listen LOOPBACK_IP:PORT].');
    }
    values.set(key, value);
  }
  if (!values.has('--frontend') || !values.has('--runtime-url')) throw new Error('--frontend and --runtime-url are required.');
  const listen = localOrigin('http://' + (values.get('--listen') ?? '127.0.0.1:3000'), true);
  return { frontend: values.get('--frontend'), runtime: localOrigin(values.get('--runtime-url')),
    host: addressHost(listen), port: listen.port ? Number(listen.port) : 80 };
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

export async function createLocalFrontendServer({ frontend, runtime: runtimeValue }) {
  let runtime = localOrigin(String(runtimeValue)), runtimePaused = false, activeRuntimeRequests = 0;
  const root = await realpath(frontend);
  if (!(await stat(root)).isDirectory()) throw new Error('The frontend must be a directory.');
  let server;
  const reply = (response, status, text) => {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); response.end(text);
  };
  server = createServer(async (request, response) => {
    const bound = server.address();
    const host = `${bound.address.includes(':') ? '[' + bound.address + ']' : bound.address}:${bound.port}`;
    const origin = `http://${host}`;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (!loopback(request.socket.remoteAddress) || countHeader(request, 'host') !== 1
      || countHeader(request, 'origin') > 1 || request.headers.host !== host
      || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      return reply(response, 403, 'local origin rejected');
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')
      || request.url.length > 4096) return reply(response, 400, 'invalid local request');
    if (request.url.startsWith('/api/')) {
      if (runtimePaused) {
        response.setHeader('retry-after', '1');
        request.resume();
        return reply(response, 503, 'local module reload in progress');
      }
      // Capture one target for the entire request, including its headers. Only
      // the local stack owner can change the target; HTTP exposes no controls.
      const target = runtime;
      activeRuntimeRequests += 1;
      response.once('close', () => { activeRuntimeRequests -= 1; });
      // Never forward ambient cookies, account grants, custom Host or redirect a
      // request to a provider-selected address. Credentials belong to the app.
      const headers = { host: target.host, origin: target.origin };
      if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
      const upstream = requestHttp({ hostname: addressHost(target), port: target.port || 80,
        method: request.method, path: request.url.slice(4), headers, agent: false }, incoming => {
        const responseHeaders = { 'content-type': incoming.headers['content-type'] ?? 'application/octet-stream' };
        if (incoming.headers['retry-after']) responseHeaders['retry-after'] = incoming.headers['retry-after'];
        // Buffer within the ABI response limit before emitting success. This
        // prevents an oversized or truncated upstream reply appearing complete.
        const chunks = []; let size = 0;
        incoming.on('data', chunk => {
          size += chunk.length;
          if (size > BASELINE_RESPONSE_BYTES) {
            incoming.destroy(); upstream.destroy(); reply(response, 502, 'local response limit exceeded');
          } else chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (!response.writableEnded && !response.destroyed) {
            response.writeHead(incoming.statusCode, responseHeaders); response.end(Buffer.concat(chunks));
          }
        });
        incoming.on('error', () => reply(response, 502, 'local runtime response unavailable'));
      });
      const deadline = setTimeout(() => {
        upstream.destroy(); reply(response, 504, 'local runtime request timed out');
      }, 35_000);
      const bodyDeadline = setTimeout(() => {
        upstream.destroy(); reply(response, 408, 'local request body timed out');
      }, 5000);
      request.on('end', () => clearTimeout(bodyDeadline));
      let received = 0;
      request.on('data', chunk => {
        received += chunk.length;
        if (received > BASELINE_REQUEST_BYTES) {
          upstream.destroy(); reply(response, 413, 'local request limit exceeded');
        }
      });
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => { clearTimeout(deadline); clearTimeout(bodyDeadline); upstream.destroy(); });
      upstream.on('error', () => reply(response, 502, 'local runtime unavailable'));
      request.pipe(upstream);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reply(response, 405, 'static files require GET or HEAD');
    let file;
    try {
      const pathname = decodeURIComponent(request.url.split('?')[0]);
      const segments = pathname.split('/');
      if (segments.some(part => part === '..' || part.startsWith('.') || part.includes('\0') || part.includes('\\'))) {
        return reply(response, 404, 'local file unavailable');
      }
      const requested = path.join(root, pathname === '/' ? 'index.html' : pathname);
      const resolved = await realpath(requested);
      if (!resolved.startsWith(root + path.sep)) return reply(response, 404, 'local file unavailable');
      file = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await file.stat();
      const type = mime[path.extname(resolved).toLowerCase()];
      if (!metadata.isFile() || !type || metadata.size > BASELINE_RESPONSE_BYTES) {
        return reply(response, 404, 'local file unavailable');
      }
      // Read through the already checked descriptor, with one extra byte to
      // reject growth during the read. Allocation never exceeds the file cap.
      let contents;
      if (request.method !== 'HEAD') {
        contents = Buffer.alloc(metadata.size + 1);
        let size = 0;
        while (size < contents.length) {
          const { bytesRead } = await file.read(contents, size, contents.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size !== metadata.size) return reply(response, 404, 'local file changed');
        contents = contents.subarray(0, size);
      }
      response.setHeader('content-type', type);
      response.setHeader('content-length', metadata.size);
      response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.end(contents);
    } catch { reply(response, 404, 'local file unavailable'); }
    finally { if (file) await file.close(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('clientError', (_, socket) => socket.destroy());
  Object.defineProperties(server, {
    setRuntime: { value: value => { runtime = localOrigin(String(value)); } },
    setRuntimePaused: { value: value => {
      if (typeof value !== 'boolean') throw new Error('invalid_local_runtime_pause');
      runtimePaused = value;
    } },
    activeRuntimeRequests: { get: () => activeRuntimeRequests },
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const configuration = options(process.argv.slice(2));
    const server = await createLocalFrontendServer(configuration);
    server.on('error', () => { console.error('Local frontend listener unavailable.'); process.exitCode = 1; });
    server.listen(configuration.port, configuration.host, () => {
      const address = server.address();
      console.log(JSON.stringify({ schema: 'blinkhost.local-frontend/v1',
        url: `http://${address.address.includes(':') ? '[' + address.address + ']' : address.address}:${address.port}`,
        runtime: configuration.runtime.origin, production_authority: false }));
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(); server.closeAllConnections();
    });
  } catch { console.error('Invalid local frontend configuration. See local-development/README.md.'); process.exitCode = 2; }
}
