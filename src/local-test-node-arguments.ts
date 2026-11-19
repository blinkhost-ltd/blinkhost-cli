import { CliError, EXIT } from './errors.js';

/** Used by both local configuration and the isolated Node adapter; no shell parsing. */
export function validateNodeTestArguments(args: unknown): asserts args is string[] {
  if (!Array.isArray(args) || args.length > 64
    || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))
    || args.reduce((sum, arg: string) => sum + Buffer.byteLength(arg), 0) > 32_768) {
    throw new CliError('Node runner args must be bounded literal strings.', EXIT.validation, 'invalid_local_test_config');
  }
  if (args.some(arg => /^--(?:test-reporter(?:-destination)?|test-isolation|test-watch|watch|watch-path|test-only|eval|print|input-type)(?:=|$)/.test(arg)
    || arg === '-e' || arg === '-p' || arg === '--print')) {
    throw new CliError('Node runner args cannot change the result protocol or execution mode.', EXIT.validation, 'invalid_local_test_config');
  }
}
