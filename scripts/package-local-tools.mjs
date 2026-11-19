/** Ship the canonical local tool and its exact relative imports in the CLI archive. */
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cli = fileURLToPath(new URL('../', import.meta.url));
const shared = path.resolve(cli, 'local-tools');
for (const filename of ['local-development/local-stack.mjs', 'local-development/frontend-proxy.mjs', 'local-development/provider-fixtures.mjs',
  'local-development/provider-grants.mjs',
  'local-development/artifact-watch.mjs',
  'local-development/native-database.mjs',
  'local-development/blinkhost.local.example.json', 'local-development/README.md', 'local-development/hello.rs', 'javascript-runtime/resource-profiles.js',
  'javascript-runtime/resource-limits.js', 'local-development/provider-fixtures.example.json', 'local-development/test-provider-example.mjs']) {
  const destination = path.join(cli, 'dist', filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(shared, filename), destination);
}
