import { CliError, EXIT } from './errors.js';

/** One command for security's stdin parser, not a shell or process argument. */
export function macosKeychainWrite(profile: string, token: string): {
  command: string; args: string[]; input: string;
} {
  if (!/^bhr_[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new CliError('The server returned an invalid refresh credential.', EXIT.auth, 'invalid_refresh_credential');
  }
  // Normal CLI profiles are more restrictive. This boundary also handles the
  // quoted synthetic native-vault fixtures without admitting another input line.
  if (!profile || profile.length > 128 || !/^[\x20-\x7e]+$/.test(profile)) {
    throw new CliError('The credential profile is invalid.', EXIT.auth, 'invalid_profile');
  }
  const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;
  const input = `add-generic-password -U -s blinkhost-cli -a ${quote(profile)} -w ${quote(token)}\n`;
  // Apple's security input buffer is 4096 bytes. Keep newline and NUL inside
  // it. Exactly one line followed by EOF preserves this command's exit status;
  // adding "quit" or a readback command could mask a failed write.
  if (Buffer.byteLength(input, 'utf8') >= 4096) {
    throw new CliError('The credential request is too large.', EXIT.auth, 'credential_store_configuration_invalid');
  }
  return { command: '/usr/bin/security', args: ['-q', '-i'], input };
}
