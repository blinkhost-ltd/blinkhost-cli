import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../errors.js';
import { parseLocalTestResults, LOCAL_TEST_RESULT_LIMITS } from '../local-test-results.js';
import { validateNodeTestArguments } from '../local-test-node-arguments.js';

const sink = { directory: '/work', path: '/work/results-synthetic.json', runId: 'synthetic-run', device: 0, inode: 0 };
const check = { id: 'unit', profile: 'native' as const };
function raw(changes: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ schema: 'blinkhost.local-test-results/v1', run_id: sink.runId,
    check_id: check.id, profile: 'native', runner: 'fixture/1', tests: [
      { id: 'one', name: 'password=private-fixture synthetic-run /work/results-synthetic.json', status: 'passed' },
    ], ...changes }));
}
test('captured result bytes use the same counts, digest, context and credential screening as file import', () => {
  const bytes = raw();
  const report = parseLocalTestResults(bytes, sink, check);
  assert.deepEqual(report.counts, { total: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0 });
  assert.equal(report.source_bytes, bytes.length);
  assert.equal(report.authority, 'customer_runner_reported');
  assert.doesNotMatch(JSON.stringify(report), /private-fixture|synthetic-run|\/work/);
  assert.match(report.tests[0]!.name, /REDACTED/);
});
test('captured byte import refuses malformed UTF-8, excessive bytes, wrong identity and count injection', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(0), Buffer.alloc(LOCAL_TEST_RESULT_LIMITS.bytes + 1),
    raw({ run_id: 'other' }), raw({ check_id: 'other' }), raw({ profile: 'wasm' }), raw({ counts: { passed: 99 } }),
    raw({ tests: [{ id: 'x', name: 'x', status: 'passed' }, { id: 'x', name: 'x', status: 'passed' }] })]) {
    assert.throws(() => parseLocalTestResults(bytes, sink, check), error => error instanceof CliError
      && error.code === 'invalid_local_test_results' && !error.message.includes('private-fixture'));
  }
  for (const limit of [0, -1, NaN, 1.5, 1]) assert.throws(() => parseLocalTestResults(raw(), sink, check, limit));
});
test('empty and entirely skipped reports cannot invent executed tests or collected coverage', () => {
  assert.equal(parseLocalTestResults(raw({ tests: [] }), sink, check).status, 'no_tests');
  assert.equal(parseLocalTestResults(raw({ tests: [{ id: 'x', name: 'x', status: 'skipped' }] }), sink, check).status, 'skipped');
  assert.throws(() => parseLocalTestResults(raw({ tests: [],
    coverage: { status: 'collected', metrics: { lines: { covered: 1, total: 1 } } } }), sink, check));
});
test('shared Node argument validation prevents result protocol replacement in either execution path', () => {
  validateNodeTestArguments(['--experimental-test-coverage', 'unit.test.mjs']);
  for (const args of [['--test-reporter=other'], ['--test-reporter-destination=/tmp/result'], ['--test-isolation=none'],
    ['--test-only'], ['--eval=x'], ['-e'], ['--watch'], ['x\nother'], [1], Array(65).fill('x')]) {
    assert.throws(() => validateNodeTestArguments(args));
  }
});
