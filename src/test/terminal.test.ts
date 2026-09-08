import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminalJson, terminalText } from '../terminal.js';

const controls = '\u202e\u2066\u2069\u200b\ufeff\x1b\x08\x7f\x85\u2028\u2029\u{e0001}';

test('human terminal output exposes controls and preserves normal Unicode', () => {
  const rendered = terminalText(controls);
  for (const char of controls) {
    assert.ok(!rendered.includes(char));
    assert.ok(rendered.includes(`[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`));
  }
  assert.equal(terminalText('\tHello 🌍 مرحبا e\u0301 \\u202e\n'), '\tHello 🌍 مرحبا e\u0301 \\u202e\n');
  assert.equal(terminalText('a\rb'), 'a[U+000D]b');
});

test('JSON remains lossless with safe keys, nested values and supplementary controls', () => {
  const value = { [controls]: [controls, { source: '\tHello 🌍 مرحبا \\u202e\n' }], literal: '[U+202E]' };
  for (const indent of [undefined, 2]) {
    const rendered = terminalJson(JSON.stringify(value, null, indent));
    for (const char of controls) assert.ok(!rendered.includes(char));
    assert.deepEqual(JSON.parse(rendered), value);
    assert.equal(terminalJson(rendered), rendered);
  }
});

test('CLI error envelope escapes terminal controls without changing the command value', () => {
  const command = 'unknown\u202e\u{e0001}';
  const result = spawnSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, command, '--json'], {
    encoding: 'utf8', env: { ...process.env, BLINKHOST_NO_UPDATE_NOTIFIER: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('\u202e'));
  assert.ok(!result.stdout.includes('\u{e0001}'));
  assert.equal(JSON.parse(result.stdout).command, command);
});
