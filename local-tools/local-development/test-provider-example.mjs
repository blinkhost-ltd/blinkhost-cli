/** Adaptable native customer test. Only explicit, harness-owned loopback fixtures. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const env = process.env;
assert.ok(env.BLINKHOST_LOCAL_PROVIDER_FIXTURES && Buffer.byteLength(env.BLINKHOST_LOCAL_PROVIDER_FIXTURES) <= 4096,
  'supply the three owned provider fixture origins');
const origins = JSON.parse(env.BLINKHOST_LOCAL_PROVIDER_FIXTURES);
assert.ok(origins && typeof origins === 'object' && !Array.isArray(origins));
assert.deepEqual(Object.keys(origins).sort(), ['ai', 'email', 'payment']);
for (const origin of Object.values(origins)) {
  assert.ok(typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin), 'fixture origins must be explicit loopback URLs');
  assert.equal(new URL(origin).origin, origin, 'fixture origins must be canonical');
}
assert.equal(new Set(Object.values(origins)).size, 3, 'provider fixtures must be distinct');
const contextKeys = ['BLINKHOST_TEST_RESULT_PATH', 'BLINKHOST_TEST_RUN_ID', 'BLINKHOST_TEST_CHECK_ID', 'BLINKHOST_TEST_PROFILE'];
const reporting = contextKeys.some(key => env[key] !== undefined);
if (reporting) {
  assert.ok(contextKeys.every(key => env[key]), 'structured results require a complete test context');
  assert.equal(env.BLINKHOST_TEST_PROFILE, 'native', 'direct fixture HTTP tests use the native profile');
}
const tests = [];
async function check(id, action) {
  const started = performance.now(); let status = 'passed';
  try { await action(); }
  catch (error) { status = 'failed'; throw error; }
  finally { tests.push({ id, name: id, status, duration_ms: Math.round(performance.now() - started),
    ...(status === 'failed' ? { message: 'The customer provider fixture assertion failed.' } : {}) }); }
}
async function call(provider, path, body, headers = {}) {
  const response = await fetch(origins[provider] + path, { method: 'POST', body, headers,
    redirect: 'error', signal: AbortSignal.timeout(3000) });
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length; assert.ok(bytes <= 65_536, 'provider fixture response exceeds the test bound');
    chunks.push(chunk);
  }
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
}
let failure;
try {
  await check('email-body-mismatch', async () => assert.equal((await call('email', '/send', 'wrong')).status, 422));
  await check('email-rate-limit', async () => {
    const response = await call('email', '/send', 'customer-email');
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(JSON.parse(response.body), { error: 'limited' });
  });
  await check('email-retry-success', async () => {
    const response = await call('email', '/send', 'customer-email');
    assert.equal(response.status, 202); assert.deepEqual(JSON.parse(response.body), { id: 'local-send' });
  });
  await check('email-sequence-exhausted', async () => assert.equal((await call('email', '/send', 'customer-email')).status, 409));
  await check('payment-declined', async () => {
    const response = await call('payment', '/charge', 'customer-payment');
    assert.equal(response.status, 402); assert.deepEqual(JSON.parse(response.body), { error: 'declined' });
  });
  await check('ai-stream-complete', async () => {
    const response = await call('ai', '/chat', 'customer-prompt');
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.body, 'data: {"token":"hello"}\n\ndata: [DONE]\n\n');
  });
  await check('unexpected-route', async () => assert.equal((await call('ai', '/unconfigured', 'input')).status, 404));
  await check('remote-browser-origin-denied', async () =>
    assert.equal((await call('ai', '/chat', 'input', { origin: 'https://remote.example' })).status, 403));
} catch (error) { failure = error; }
if (reporting) {
  await writeFile(env.BLINKHOST_TEST_RESULT_PATH, JSON.stringify({ schema: 'blinkhost.local-test-results/v1',
    run_id: env.BLINKHOST_TEST_RUN_ID, check_id: env.BLINKHOST_TEST_CHECK_ID,
    runner: 'Customer-owned provider fixture example', profile: 'native', tests,
    coverage: { status: 'not_collected' } }) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ schema: 'blinkhost.local-provider-test/v1', passed: !failure,
  tests, production_authority: false, guest_provider_integration: false, coverage: 'not_collected' }));
if (failure) { console.error('customer_provider_fixture_assertion_failed'); process.exitCode = 1; }
