#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, EXIT } from './errors.js';
import {
  SUPPORTED_FRONTENDS,
  SUPPORTED_MANAGERS,
  SUPPORTED_MODULES,
  type FrontendFramework,
  type ModuleLanguage,
  type PackageManager,
} from './manifest.js';
import { detectManifest } from './detect.js';
import { readProjectManifest, resolveLocalPath, validateProject, writeManifest, writeScaffoldAtomically } from './project.js';
import { createScaffold, type ScaffoldModule } from './templates.js';

const VERSION = '1.0.0';
const HELP = `BlinkHost CLI ${VERSION}

Usage:
  blinkhost create <project-name> [--template react] [--package-manager npm]
                 [--module name:python] [--database APP_DB] [--no-install]
  blinkhost init [path] [--force]
  blinkhost validate [path]
  blinkhost manifest [path]
  blinkhost doctor [path]

Global options:
  --json       Return machine-readable output
  --help       Show command help
  --version    Show the CLI version

The CLI never stores credentials, follows symbolic links, overwrites a project during
create, or runs dependency lifecycle scripts. Deployment remains available through
the BlinkHost dashboard until a dedicated short-lived CLI authorization flow ships.
`;

interface Output { ok: boolean; command: string; message: string; data?: unknown; warnings?: string[] }

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

function emit(output: Output, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(output)}\n`);
  else {
    process.stdout.write(`${terminalText(output.message)}\n`);
    for (const warning of output.warnings ?? []) process.stderr.write(`Warning: ${terminalText(warning)}\n`);
  }
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`${name} requires a value.`, EXIT.usage, 'missing_option_value');
  args.splice(index, 2);
  return value;
}

function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  let index = args.indexOf(name);
  while (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliError(`${name} requires a value.`, EXIT.usage, 'missing_option_value');
    values.push(value);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function assertNoUnknown(args: string[]): void {
  if (args.length) throw new CliError(`Unexpected argument: ${args[0]}`, EXIT.usage, 'unexpected_argument');
}

function parseModule(value: string): ScaffoldModule {
  const [name, language, extra] = value.split(':');
  if (extra || !name || !language || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || !SUPPORTED_MODULES.includes(language as ModuleLanguage)) {
    throw new CliError('Use --module name:language with a safe name and python, go or rust.', EXIT.usage, 'invalid_module');
  }
  return { name, language: language as ModuleLanguage };
}

async function runProcess(command: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: 'inherit', env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    child.once('error', () => reject(new CliError(`The ${command} executable is not available.`, EXIT.filesystem, 'package_manager_unavailable')));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function commandCreate(args: string[], json: boolean): Promise<void> {
  const name = args.shift();
  if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) throw new CliError('Project name must use lowercase letters, numbers and internal hyphens.', EXIT.usage, 'invalid_project_name');
  const framework = (takeOption(args, '--template') ?? 'react') as FrontendFramework;
  const packageManager = (takeOption(args, '--package-manager') ?? 'npm') as PackageManager;
  const moduleValues = takeRepeatedOption(args, '--module');
  const database = takeOption(args, '--database');
  const noInstall = takeFlag(args, '--no-install');
  const explicitInstall = takeFlag(args, '--install');
  if (noInstall && explicitInstall) throw new CliError('Choose either --install or --no-install.', EXIT.usage, 'conflicting_options');
  const install = !noInstall;
  assertNoUnknown(args);
  if (!SUPPORTED_FRONTENDS.includes(framework)) throw new CliError(`Unsupported template: ${framework}.`, EXIT.usage, 'invalid_template');
  if (!SUPPORTED_MANAGERS.includes(packageManager)) throw new CliError(`Unsupported package manager: ${packageManager}.`, EXIT.usage, 'invalid_package_manager');
  if (database && !/^[A-Z][A-Z0-9_]{0,127}$/.test(database)) throw new CliError('Database bindings use uppercase letters, numbers and underscores.', EXIT.usage, 'invalid_database');
  const modules = moduleValues.map(parseModule);
  if (new Set(modules.map((item) => item.name)).size !== modules.length) throw new CliError('Backend module names must be unique.', EXIT.usage, 'duplicate_module');
  const target = resolveLocalPath(name);
  const scaffold = createScaffold({ name, framework, packageManager, modules, ...(database ? { database } : {}) });
  await writeScaffoldAtomically(target, scaffold.files, scaffold.manifest);
  if (install && framework !== 'html') {
    const installArgs: Record<PackageManager, string[]> = {
      npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--no-progress'],
      pnpm: ['install', '--ignore-scripts', '--prefer-offline'],
      yarn: ['install', '--mode=skip-build'],
      bun: ['install', '--ignore-scripts', '--no-progress'],
    };
    const code = await runProcess(packageManager, installArgs[packageManager], target);
    if (code !== 0) throw new CliError(`Dependency installation exited with code ${code}. The project files were kept.`, EXIT.filesystem, 'install_failed');
  }
  emit({ ok: true, command: 'create', message: `Created ${name} at ${target}.`, data: { path: target, framework, modules: modules.length, installed: install && framework !== 'html' } }, json);
}

async function commandInit(args: string[], json: boolean): Promise<void> {
  const force = takeFlag(args, '--force');
  const path = args.shift();
  assertNoUnknown(args);
  const root = resolveLocalPath(path);
  const manifest = await detectManifest(root);
  await writeManifest(root, manifest, force);
  emit({ ok: true, command: 'init', message: `Created blinkhost.yaml in ${root}.`, data: { path: root, framework: manifest.frontend.framework } }, json);
}

async function commandValidate(args: string[], json: boolean): Promise<void> {
  const path = args.shift();
  assertNoUnknown(args);
  const root = resolveLocalPath(path);
  const result = await validateProject(root);
  if (result.errors.length) throw new CliError('Project validation failed.', EXIT.validation, 'project_invalid', result.errors);
  emit({ ok: true, command: 'validate', message: `Project is compatible with ${result.manifest.schema}.`, data: { framework: result.manifest.frontend.framework, modules: result.manifest.modules.length, databases: result.manifest.resources.databases.length }, warnings: result.warnings }, json);
}

async function commandManifest(args: string[], json: boolean): Promise<void> {
  const path = args.shift();
  assertNoUnknown(args);
  const manifest = await readProjectManifest(resolveLocalPath(path));
  if (json) emit({ ok: true, command: 'manifest', message: 'Manifest parsed.', data: manifest }, true);
  else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function commandDoctor(args: string[], json: boolean): Promise<void> {
  const path = args.shift();
  assertNoUnknown(args);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const supportedNode = (nodeMajor ?? 0) > 22 || nodeMajor === 22 && (nodeMinor ?? 0) >= 12;
  checks.push({ name: 'node', ok: supportedNode, detail: process.versions.node });
  let gitOk = false;
  try { gitOk = await commandAvailable('git', ['--version']); } catch {}
  checks.push({ name: 'git', ok: gitOk, detail: gitOk ? 'available' : 'not found' });
  const root = resolveLocalPath(path);
  try {
    const validation = await validateProject(root);
    checks.push({ name: 'project', ok: validation.errors.length === 0, detail: validation.errors.join('; ') || 'manifest and declared paths are valid' });
  } catch (error) {
    checks.push({ name: 'project', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try { await access(root); checks.push({ name: 'directory', ok: true, detail: root }); } catch { checks.push({ name: 'directory', ok: false, detail: 'not accessible' }); }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) throw new CliError('One or more environment checks failed.', EXIT.validation, 'doctor_failed', failed.map((check) => `${check.name}: ${check.detail}`));
  emit({ ok: true, command: 'doctor', message: 'BlinkHost project environment is ready.', data: { checks } }, json);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = [...argv];
  const json = takeFlag(args, '--json');
  const command = args.shift();
  try {
    if (!command || command === '--help' || command === 'help') { process.stdout.write(HELP); return EXIT.success; }
    if (command === '--version' || command === 'version') { process.stdout.write(`${VERSION}\n`); return EXIT.success; }
    if (takeFlag(args, '--help')) { process.stdout.write(HELP); return EXIT.success; }
    if (command === 'create') await commandCreate(args, json);
    else if (command === 'init') await commandInit(args, json);
    else if (command === 'validate') await commandValidate(args, json);
    else if (command === 'manifest') await commandManifest(args, json);
    else if (command === 'doctor') await commandDoctor(args, json);
    else throw new CliError(`Unknown command: ${command}.`, EXIT.usage, 'unknown_command');
    return EXIT.success;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error), EXIT.internal, 'internal_error');
    if (json) process.stderr.write(`${JSON.stringify({ ok: false, command: command ?? '', error: { code: failure.code, message: failure.message, details: failure.details } })}\n`);
    else {
      process.stderr.write(`Error: ${terminalText(failure.message)}\n`);
      for (const detail of failure.details) process.stderr.write(`  - ${terminalText(detail)}\n`);
    }
    return failure.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
