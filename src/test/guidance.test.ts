import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { documentationIndex, documentationTopic, quickstart, searchDocumentation, TOP_LEVEL_COMMANDS } from '../guidance.js';
import { completion } from '../workflows.js';
import { VERSION, supportedNodeVersion } from '../version.js';

test('offline documentation is versioned, searchable, and command scoped', () => {
  assert.equal(documentationIndex().cli_version, VERSION);
  assert.equal(documentationTopic('create')?.name, 'create');
  assert.equal(documentationTopic('functions')?.name, 'functions');
  assert.ok(searchDocumentation('credential').some((topic) => topic.name === 'auth' || topic.name === 'security'));
});

test('quickstart is local, read-only, and reports safety boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-quickstart-'));
  const before = await readdir(root);
  const result = await quickstart(root);
  const after = await readdir(root);
  assert.deepEqual(after, before);
  assert.equal(result.mode, 'local_read_only');
  assert.equal(result.remote_changes, false);
  assert.equal(result.billable_resources_created, false);
});

test('init dry-run returns a proposed manifest without writing files', { skip: !supportedNodeVersion() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-init-dry-run-'));
  const cli = join(process.cwd(), 'dist', 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'init', root, '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).data.written, false);
  assert.deepEqual(await readdir(root), []);
});

test('shell completion contains every public top-level command', () => {
  for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
    const script = completion(shell);
    for (const command of TOP_LEVEL_COMMANDS) assert.match(script, new RegExp(`\\b${command}\\b`));
  }
});

test('package and runtime versions remain consistent', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  assert.equal(packageJson.version, VERSION);
  assert.equal(supportedNodeVersion('22.11.0'), false);
  assert.equal(supportedNodeVersion('22.12.0'), true);
  assert.equal(supportedNodeVersion('24.0.0'), true);
});

test('scoped help and JSON failures use a single stdout object', () => {
  const cli = join(process.cwd(), 'dist', 'cli.js');
  const help = spawnSync(process.execPath, [cli, 'create', '--help', '--json'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.equal(JSON.parse(help.stdout).data.topic.name, 'create');

  const failure = spawnSync(process.execPath, [cli, 'creat', '--json'], { encoding: 'utf8' });
  assert.equal(failure.status, supportedNodeVersion() ? 2 : 4);
  assert.equal(failure.stderr, '');
  const payload = JSON.parse(failure.stdout);
  assert.equal(payload.ok, false);
  if (supportedNodeVersion()) assert.match(payload.error.message, /Did you mean `create`/);
  else assert.equal(payload.error.code, 'unsupported_node');
});

test('JSON mode keeps child-process output off stdout', { skip: !supportedNodeVersion() }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinkhost-json-child-'));
  const cli = join(process.cwd(), 'dist', 'cli.js');
  const created = spawnSync(process.execPath, [cli, 'create', 'sample', '--no-install'], { cwd: root, encoding: 'utf8' });
  assert.equal(created.status, 0);
  const project = join(root, 'sample');
  const packagePath = join(project, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts: Record<string, string> };
  packageJson.scripts.build = 'node -e "console.log(\'child stdout\'); console.error(\'child stderr\'); process.exit(1)"';
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const result = spawnSync(process.execPath, [cli, 'test', project, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /child stdout/);
  assert.match(result.stderr, /child stderr/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'project_test_failed');
});
