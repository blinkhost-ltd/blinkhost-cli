import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { CliError, EXIT } from './errors.js';
import { writeLogOutput } from './logs.js';
import { terminalJson, terminalText } from './terminal.js';
import { buildLocalSource, readSourceStackConfiguration, type LocalSourceBuildReceipt } from './local-source-build.js';
import { watchLocalSource, type LocalSourcePublication } from './local-source-watch.js';

export type LocalDevWriter = (value: string, signal: AbortSignal) => Promise<boolean>;

interface LocalStackManifest {
  schema: 'blinkhost.local-stack/v1';
  frontend: string;
  runtime: string;
  database: string;
  state_directory: string;
  production_authority: false;
}
interface LocalStackStop {
  status: 'stopped' | 'interrupted' | 'failed';
  children_stopped: boolean;
  production_authority: false;
}
interface LocalStack {
  manifest: LocalStackManifest;
  readonly runtimeAvailable: boolean;
  stop: (reason?: string) => Promise<LocalStackStop>;
  closed: Promise<LocalStackStop>;
  reload: (options?: { verifyCandidate?: () => Promise<void> }) => Promise<LocalSourcePublication>;
}

/** One foreground owner for the packaged local tool; no remote account APIs. */
export async function runLocalDev(root: string, config: string, state: string, json: boolean,
  write: LocalDevWriter = (value, signal) => writeLogOutput(process.stdout, value, signal), watchArtifact = false,
  sourceBuildConfig?: string, watchSource = false): Promise<unknown> {
  const controller = new AbortController();
  let interruptSignal: NodeJS.Signals | undefined, stack: LocalStack | undefined, outputFailed = false;
  let watching: Promise<void> | undefined;
  let sourceBuild: LocalSourceBuildReceipt | undefined;
  let sourceContext: { directory: string; originalConfig: string; originalDigest: string;
    compiledConfig: string; compiledDigest: string; generated: Record<string, unknown> } | undefined;
  const interrupt = () => { interruptSignal = 'SIGINT'; controller.abort(); };
  const terminate = () => { interruptSignal = 'SIGTERM'; controller.abort(); };
  const outputError = () => { outputFailed = true; controller.abort(); };
  // Keep handling repeated interrupts until owned servers and compilers finish stopping.
  // Removing the handler after the first signal lets the next one terminate cleanup.
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  process.stdout.on('error', outputError);
  try {
    if (watchSource && (!sourceBuildConfig || watchArtifact)) throw new CliError('Source watching requires a local source build without artifact watching.',
      EXIT.usage, 'local_source_watch_options_required');
    const tool = new URL('./local-development/local-stack.mjs', import.meta.url);
    const { startLocalStack, configuration } = await import(tool.href) as {
      startLocalStack: (filename: string, directory: string, options: { signal: AbortSignal }) => Promise<LocalStack>;
      configuration: (value: Record<string, unknown>, directory: string) => {
        runtime: { path: string; sha256: string }; engine: { path: string; sha256: string };
        database: { path: string; sha256: string }; frontend: string;
      };
    };
    let configPath = resolve(root, config), statePath = resolve(root, state);
    if (sourceBuildConfig !== undefined) {
      if (watchArtifact) throw new CliError('Source builds and separately compiled artifact watching require separate development runs.',
        EXIT.usage, 'local_source_build_watch_conflict');
      const original = await readSourceStackConfiguration(configPath);
      const validated = configuration(original.value, dirname(configPath));
      const offset = relative(validated.frontend, statePath);
      if (!offset || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('../'))) {
        throw new CliError('Local source-build state must stay outside the served frontend.', EXIT.validation, 'local_source_build_state_in_frontend');
      }
      await mkdir(statePath, { mode: 0o700 });
      sourceBuild = await buildLocalSource(root, sourceBuildConfig, join(statePath, 'build-001'), { signal: controller.signal });
      if (controller.signal.aborted) throw new Error('local_source_build_cancelled');
      if ((await readSourceStackConfiguration(configPath)).sha256 !== original.sha256) throw new Error('local_source_build_stack_configuration_changed');
      if (!sourceBuild.artifact) throw new Error('local_source_build_artifact_missing');
      const generated = { ...original.value, runtime: validated.runtime, engine: validated.engine,
        database: { ...(original.value.database as Record<string, unknown>), executable: validated.database },
        frontend: validated.frontend, artifact: { path: sourceBuild.artifact.path, sha256: sourceBuild.artifact.sha256 } };
      configPath = join(statePath, 'compiled-stack.json');
      await writeFile(configPath, JSON.stringify(generated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      sourceContext = { directory: statePath, originalConfig: resolve(root, config), originalDigest: original.sha256,
        compiledConfig: configPath, compiledDigest: (await readSourceStackConfiguration(configPath)).sha256, generated };
      statePath = join(statePath, 'stack');
    }
    stack = await startLocalStack(configPath, statePath, { signal: controller.signal });
    const output = json ? terminalJson(JSON.stringify({ ok: true, command: 'dev', event: 'ready', data: stack.manifest })) + '\n'
      : terminalText(`Local frontend: ${stack.manifest.frontend}\nLocal runtime: ${stack.manifest.runtime}\nLocal database: ${stack.manifest.database}\nState: ${JSON.stringify(stack.manifest.state_directory)}\nPress Ctrl-C to stop this stack.\n`);
    // A stalled readiness pipe must not retain the stack indefinitely.
    const written = await write(output, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
    if (!written) {
      outputFailed = true; controller.abort();
      throw new CliError('Local development readiness output could not be delivered. The owned stack was stopped.', EXIT.filesystem, 'local_dev_output_failed');
    }
    if (watchSource && sourceBuildConfig && sourceBuild && sourceContext) {
      const owned = stack, context = sourceContext;
      const verifyConfiguration = async () => {
        if ((await readSourceStackConfiguration(context.originalConfig)).sha256 !== context.originalDigest) throw new Error('local_source_build_stack_configuration_changed');
        if ((await readSourceStackConfiguration(context.compiledConfig)).sha256 !== context.compiledDigest) throw new Error('local_source_build_generated_configuration_changed');
      };
      watching = watchLocalSource(root, sourceBuildConfig, context.directory, sourceBuild, async (build, verifySource) => {
        await verifyConfiguration();
        await verifySource();
        if (!build.artifact) throw new Error('local_source_build_artifact_missing');
        const generated = { ...context.generated, artifact: { path: build.artifact.path, sha256: build.artifact.sha256 } };
        const temporary = join(dirname(build.artifact.path), 'stack-candidate.json');
        await writeFile(temporary, JSON.stringify(generated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await verifyConfiguration(); await verifySource();
        await rename(temporary, context.compiledConfig);
        context.compiledDigest = (await readSourceStackConfiguration(context.compiledConfig)).sha256;
        const result = await owned.reload({ verifyCandidate: async () => { await verifyConfiguration(); await verifySource(); } });
        if (result.status !== 'rejected') sourceBuild = build;
        return result;
      }, () => owned.runtimeAvailable, async event => {
        const value = json ? terminalJson(JSON.stringify({ ok: event.status !== 'rejected', command: 'dev',
          event: event.status === 'reloaded' ? 'reloaded' : event.status === 'unchanged' ? 'build_unchanged' : 'build_failed', data: event })) + '\n'
          : terminalText(event.status === 'reloaded' ? 'Local source rebuilt and module reloaded.\n'
            : event.status === 'unchanged' ? 'Local source rebuilt; the compiled module is unchanged.\n'
              : `Local source rebuild rejected: ${event.error ?? 'local_source_rebuild_failed'}.${event.watching_stopped ? ' Watching stopped; start a new development run.' : ' Inspect the retained build evidence.'}\n`);
        if (!await write(value, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]))) throw new Error('local_dev_output_failed');
      }, { signal: controller.signal });
      watching.catch(() => { outputFailed = true; controller.abort(); });
    } else if (watchArtifact) {
      const watcher = new URL('./local-development/artifact-watch.mjs', import.meta.url);
      const { watchLocalArtifacts } = await import(watcher.href) as {
        watchLocalArtifacts: (stack: LocalStack, filename: string,
          onEvent: (event: { status: string; error?: string }) => Promise<void>,
          options: { signal: AbortSignal }) => Promise<void>;
      };
      watching = watchLocalArtifacts(stack, resolve(root, config), async event => {
        const value = json ? terminalJson(JSON.stringify({ ok: event.status === 'reloaded', command: 'dev',
          event: event.status === 'reloaded' ? 'reloaded' : 'reload_failed', data: event })) + '\n'
          : terminalText(event.status === 'reloaded' ? 'Local module reloaded.\n'
            : `Local module reload rejected: ${event.error ?? 'local_stack_reload_failed'}. Inspect the retained state.\n`);
        if (!await write(value, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]))) {
          throw new Error('local_dev_output_failed');
        }
      }, { signal: controller.signal });
      watching.catch(() => { outputFailed = true; controller.abort(); });
    }
    const stopped = await stack.closed;
    if (outputFailed) throw new CliError('Local development output closed. The owned stack was stopped.', EXIT.filesystem, 'local_dev_output_failed');
    if (stopped.status === 'failed' || !stopped.children_stopped) {
      throw new CliError('A local stack process failed. Inspect the retained process logs and stopped.json in your state directory.', EXIT.remote, 'local_stack_process_failed');
    }
    return { schema: 'blinkhost.local-dev/v1', status: stopped.status, stack: stack.manifest,
      shutdown: stopped, exit_code: 0, production_authority: false,
      ...(sourceBuild ? { source_build: sourceBuild } : {}) };
  } catch (error) {
    if (outputFailed) throw new CliError('Local development output closed. The owned stack was stopped.', EXIT.filesystem, 'local_dev_output_failed');
    if (interruptSignal) throw new CliError('Local stack startup was interrupted.', interruptSignal === 'SIGINT' ? 130 : 143, 'local_stack_startup_interrupted');
    if (error instanceof CliError) throw error;
    const code = error instanceof Error && /^[a-z_]{1,96}$/.test(error.message) ? error.message : 'local_stack_start_failed';
    throw new CliError('Local stack startup failed. Check your explicit configuration, pinned tools and retained state evidence.', EXIT.validation, code);
  } finally {
    controller.abort();
    if (stack) await stack.stop();
    if (watching) await watching.catch(() => {});
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.stdout.off('error', outputError);
  }
}
