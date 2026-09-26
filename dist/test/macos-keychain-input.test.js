import assert from 'node:assert/strict';
import test from 'node:test';
import { macosKeychainWrite } from '../macos-keychain-input.js';
import { CliError } from '../errors.js';
const token = `bhr_${'synthetic_value_'.repeat(3)}`;
const failsWith = (expected) => (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, expected);
    assert.ok(!String(error).includes(token));
    return true;
};
test('macOS writes carry the secret only in stdin, with one command and EOF', () => {
    const request = macosKeychainWrite('test-profile', token);
    assert.equal(request.command, '/usr/bin/security');
    assert.deepEqual(request.args, ['-q', '-i']);
    assert.ok(!request.args.some(arg => arg.includes(token)));
    assert.equal(request.input, `add-generic-password -U -s blinkhost-cli -a "test-profile" -w "${token}"\n`);
    assert.equal(request.input.split('\n').length, 2);
    assert.ok(Buffer.byteLength(request.input) < 4096);
});
test('macOS input quotes parser metacharacters without invoking a shell', () => {
    const profile = `test-'quoted"\\ $value; quit`;
    const request = macosKeychainWrite(profile, token);
    assert.equal(request.input, `add-generic-password -U -s blinkhost-cli -a "test-'quoted\\"\\\\ $value; quit" -w "${token}"\n`);
});
test('macOS boundary rejects multiline, control, oversized and empty profiles', () => {
    for (const profile of ['', 'x\nquit', 'x\rquit', 'x\u0000quit', 'x\tquit', 'x\u001bquit', 'x\u007f', 'x'.repeat(129)]) {
        assert.throws(() => macosKeychainWrite(profile, token), failsWith('invalid_profile'));
    }
});
test('macOS boundary rejects credential injection and malformed tokens before I/O', () => {
    for (const value of ['', 'not-a-refresh-credential', 'bhr_short', `${token}\nquit`, `${token}"`, `${token}\\`, `${token}\u0000`, `bhr_${'x'.repeat(257)}`]) {
        assert.throws(() => macosKeychainWrite('test-profile', value), failsWith('invalid_refresh_credential'));
    }
});
test('maximum supported values remain far below the native parser line bound', () => {
    const request = macosKeychainWrite('"'.repeat(128), `bhr_${'x'.repeat(256)}`);
    assert.ok(Buffer.byteLength(request.input) < 1024);
    assert.equal(request.input.split('\n').length, 2);
});
//# sourceMappingURL=macos-keychain-input.test.js.map