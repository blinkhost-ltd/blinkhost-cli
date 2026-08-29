import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlinkHostManifest, FrontendFramework, PackageManager } from './manifest.js';

async function readable(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}

export async function detectManifest(root: string): Promise<BlinkHostManifest> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Project path must be a regular directory.');
  let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    const packagePath = join(root, 'package.json');
    if ((await lstat(packagePath)).isSymbolicLink()) throw new Error('package.json cannot be a symbolic link.');
    packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as typeof packageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  let framework: FrontendFramework = 'html';
  if ('astro' in dependencies) framework = 'astro';
  else if ('react' in dependencies) framework = 'react';
  else if ('vue' in dependencies) framework = 'vue';
  else if ('svelte' in dependencies) framework = 'svelte';
  else if ('solid-js' in dependencies) framework = 'solid';
  let packageManager: PackageManager = 'npm';
  if (await readable(join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (await readable(join(root, 'yarn.lock'))) packageManager = 'yarn';
  else if (await readable(join(root, 'bun.lock')) || await readable(join(root, 'bun.lockb'))) packageManager = 'bun';
  const install = packageManager === 'npm' ? 'npm ci' : `${packageManager} install --frozen-lockfile`;
  return {
    schema: 'blinkhost/v1', application: { root: '.' },
    frontend: {
      root: '.', dependency_root: '.', framework, package_manager: packageManager,
      install: framework === 'html' ? '' : install,
      build: framework === 'html' ? '' : `${packageManager} run build`,
      dev: framework === 'html' ? '' : `${packageManager} run dev`,
      output: framework === 'html' ? '.' : 'dist',
    },
    modules: [], resources: { databases: [], secrets: [] },
    preview: { enabled: true, database_mode: 'none' },
    ignore: ['.blinkhost', 'node_modules', 'dist'],
  };
}
