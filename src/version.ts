export const VERSION = '2.1.0';
export const DOCUMENTATION_URL = 'https://app.blinkhost.me/docs/source-control/cli';
export const RELEASES_URL = 'https://github.com/blinkhost-ltd/blinkhost-cli/releases';

export function supportedNodeVersion(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 22 || major === 22 && minor >= 12;
}
