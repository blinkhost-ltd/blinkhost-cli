import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';
import { validateCompatibility } from './compatibility.js';
import { validateResearchCatalog } from './research.js';
import { validateModuleBuild } from './module-build.js';
import { starterName, starterLanguage, validateStarter, type StarterExpected } from './starter.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`${flag} needs a value.`, EXIT.usage, 'missing_option_value');
  args.splice(index, 2);
  return value;
}

function identifier(value: string | undefined): string {
  if (!value || !uuid.test(value)) throw new CliError('Provide a valid project or task UUID.', EXIT.usage, 'invalid_identifier');
  return value;
}

function noExtra(args: string[]): void {
  if (args.length) throw new CliError('Unexpected assistant argument. Use blinkhost help ai.', EXIT.usage, 'unexpected_argument');
}

async function readRequestObject(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path?.startsWith('@') || path.length < 2) throw new CliError('Use --request @request.json. Do not put prompts or credentials in command arguments.', EXIT.usage, 'request_file_required');
  const handle = await open(path.slice(1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new CliError('The request file could not be opened safely.', EXIT.filesystem, 'request_file_unavailable');
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 16384) throw new CliError('Use a regular request file no larger than 16 KiB.', EXIT.validation, 'request_file_invalid');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new CliError('The request file exceeds 16 KiB.', EXIT.validation, 'request_file_invalid');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))); }
    catch { throw new CliError('The request file must contain a UTF-8 JSON object.', EXIT.validation, 'request_invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('The request must be a JSON object.', EXIT.validation, 'request_invalid');
    return value as Record<string, unknown>;
  } finally { await handle.close(); }
}

export async function readAssistantRequest(path: string | undefined): Promise<Record<string, unknown>> {
    const body = await readRequestObject(path);
    const allowed = new Set(['project_id', 'client_request_id', 'prompt', 'mode', 'model', 'maximum_units', 'source_paths', 'research_source_ids']);
    if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.project_id !== 'string' || !uuid.test(body.project_id)
      || typeof body.client_request_id !== 'string' || !uuid.test(body.client_request_id)
      || typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 8192
      || !Number.isInteger(body.maximum_units) || Number(body.maximum_units) < 1 || Number(body.maximum_units) > 2000) {
      throw new CliError('Include project_id, a stable client_request_id UUID, prompt and maximum_units (1–2000). Review blinkhost docs ai.', EXIT.validation, 'request_invalid');
    }
    if (body.source_paths !== undefined && (!Array.isArray(body.source_paths) || body.source_paths.length > 8
      || new Set(body.source_paths).size !== body.source_paths.length
      || body.source_paths.some(path => typeof path !== 'string' || !path || Buffer.byteLength(path) > 500
        || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')))) {
      throw new CliError('source_paths must contain up to eight unique project-relative file paths. Only these remote workspace files are shared; no local files are uploaded.', EXIT.validation, 'source_selection_invalid');
    }
    if (body.research_source_ids !== undefined && (!Array.isArray(body.research_source_ids)
      || body.research_source_ids.length > 4 || new Set(body.research_source_ids).size !== body.research_source_ids.length
      || body.research_source_ids.some(id => typeof id !== 'string' || !digest.test(id))
      || (body.research_source_ids.length > 0 && body.mode !== 'research'))) {
      throw new CliError('research_source_ids must contain up to four unique IDs from ai sources, only in research mode. These select reviewed excerpts, not a live web search.', EXIT.validation, 'research_selection_invalid');
    }
    return body;
}

export async function readWorkflowPlan(path: string | undefined): Promise<Record<string, unknown>> {
  const body = await readRequestObject(path);
  const allowed = new Set(['steps', 'maximum_units', 'maximum_context_units']);
  if (Object.keys(body).some(key => !allowed.has(key))
    || !Number.isSafeInteger(body.maximum_units) || Number(body.maximum_units) < 1 || Number(body.maximum_units) > 2000
    || !Number.isSafeInteger(body.maximum_context_units) || Number(body.maximum_context_units) < 1 || Number(body.maximum_context_units) > 393216
    || !Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 3
    || body.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step)
      || Object.keys(step).sort().join(',') !== 'maximum_units,mode,model'
      || !['plan', 'diagnose', 'review'].includes(step.mode)
      || !['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].includes(step.model)
      || !Number.isSafeInteger(step.maximum_units) || step.maximum_units < 1 || step.maximum_units > 2000)
    || body.steps.reduce((total, step) => total + step.maximum_units, 0) >= Number(body.maximum_units)) {
    throw new CliError('Use one to three plan, diagnose or review steps, valid models and whole-number credit limits. The total must also cover the original task. See blinkhost docs ai.', EXIT.validation, 'workflow_plan_invalid');
  }
  return body;
}

function planVersion(args: string[]): { expected_revision: number; plan_digest: string } {
  const revision = option(args, '--expected-revision');
  const value = option(args, '--digest');
  if (!revision || !/^[1-9][0-9]{0,2}$/.test(revision) || Number(revision) > 100 || !value || !digest.test(value)) {
    throw new CliError('Pass --expected-revision and --digest from the saved plan you inspected with workflow-status. Review again if the plan changes.', EXIT.usage, 'workflow_version_required');
  }
  return { expected_revision: Number(revision), plan_digest: value };
}

export async function readProjectGuidance(path: string | undefined): Promise<string> {
  if (!path?.startsWith('@') || path.length < 2) throw new CliError('Use --file @guidance.txt. Do not put guidance or credentials in command arguments.', EXIT.usage, 'guidance_file_required');
  const handle = await open(path.slice(1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new CliError('The guidance file could not be opened safely.', EXIT.filesystem, 'guidance_file_unavailable');
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 4096) throw new CliError('Use a regular UTF-8 text file no larger than 4 KiB.', EXIT.validation, 'guidance_file_invalid');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new CliError('The guidance file exceeds 4 KiB.', EXIT.validation, 'guidance_file_invalid');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { throw new CliError('The guidance file must be valid UTF-8 text.', EXIT.validation, 'guidance_file_invalid'); }
    if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new CliError('Use nonempty text without control characters. Use memory-clear to remove saved guidance.', EXIT.validation, 'guidance_file_invalid');
    return content;
  } finally { await handle.close(); }
}

export async function runAssistant(input: string[], profile?: string): Promise<{ message: string; data: unknown }> {
  const args = [...input];
  const action = args.shift();
  let path: string;
  let body: Record<string, unknown> | undefined;
  let method = 'POST';
  let message: string;
  let moduleBuildExpected: { project: string; review?: string; module?: string; revision?: string; digest?: string } | undefined;
  let starterExpected: StarterExpected | undefined;
  if (['starters', 'starter-review', 'starter-status', 'starter-approve'].includes(action ?? '')) {
    const project = identifier(option(args, '--project')).toLowerCase();
    path = `/api/idam/projects/${project}/starters/`;
    starterExpected = { project };
    if (action === 'starters') {
      message = 'Available backend starters. No files have been saved or built.';
    } else if (action === 'starter-review') {
      const name = option(args, '--name');
      const language = option(args, '--language');
      const revision = option(args, '--revision');
      const requestId = identifier(option(args, '--request-id')).toLowerCase();
      if (!starterName(name) || !starterLanguage(language) || !revision || !digest.test(revision)) {
        throw new CliError('Use a lowercase module name (1–64 letters, digits or hyphens), --language from starters and its --revision. Retain your --request-id UUID.', EXIT.usage, 'starter_request_invalid');
      }
      path += 'review/';
      body = { name, language, revision, client_request_id: requestId };
      starterExpected = { project, name, language, revision };
      message = 'Starter review prepared. Inspect every file, the project, module name and expiry before approving. No source has been saved; no build or AI credits are used.';
    } else {
      const review = identifier(args.shift()).toLowerCase();
      path += `reviews/${review}/`;
      starterExpected = { project, review };
      if (action === 'starter-approve') {
        if (option(args, '--confirm') !== review) throw new CliError('Repeat the exact review UUID with --confirm to save the reviewed starter.', EXIT.usage, 'confirmation_required');
        const value = option(args, '--digest');
        if (!value || !digest.test(value)) throw new CliError('Pass --digest from the starter review you inspected.', EXIT.usage, 'review_digest_required');
        path += 'apply/';
        body = { action_digest: value };
        starterExpected.digest = value;
        message = 'Starter source saved, not built or published. Use build-modules for the next review. Normal project limits apply; no AI credits were used.';
      } else message = 'Starter review and save receipt loaded. A historical receipt does not establish current source, build or deployment health.';
    }
    noExtra(args);
  } else if (['build-modules', 'build-review', 'build-status', 'build-approve'].includes(action ?? '')) {
    const project = identifier(option(args, '--project')).toLowerCase();
    path = `/api/idam/projects/${project}/module-builds/`;
    moduleBuildExpected = { project };
    if (action === 'build-modules') {
      message = 'Saved backend modules and compiler availability. No build has been requested.';
    } else if (action === 'build-review') {
      const module = identifier(option(args, '--module')).toLowerCase();
      const revision = option(args, '--revision');
      if (!revision || !digest.test(revision)) throw new CliError('Use --revision from build-modules for the saved source you inspected.', EXIT.usage, 'source_revision_required');
      const requestId = identifier(option(args, '--request-id')).toLowerCase();
      path += 'review/';
      body = { module_id: module, revision, client_request_id: requestId };
      moduleBuildExpected = { project, module, revision };
      message = 'Build review prepared, not started. Approval uses the normal build allowance, configured overages and duration usage; no AI credits. Inspect saved source in the IDE before approving. This never publishes.';
    } else {
      const review = identifier(args.shift()).toLowerCase();
      path += `reviews/${review}/`;
      moduleBuildExpected = { project, review };
      if (action === 'build-approve') {
        if (option(args, '--confirm') !== review) throw new CliError('Repeat the exact review UUID with --confirm to request one metered build.', EXIT.usage, 'confirmation_required');
        const value = option(args, '--digest');
        if (!value || !digest.test(value)) throw new CliError('Pass --digest from the build review you inspected.', EXIT.usage, 'review_digest_required');
        path += 'apply/';
        body = { action_digest: value };
        moduleBuildExpected.digest = value;
        message = 'Build request recorded, not published. Check build-status for progress and the IDE for diagnostics. Normal build usage applies; no AI credits.';
      } else message = 'Build review and receipt loaded. A receipt is not proof of successful compilation or deployment.';
    }
    noExtra(args);
  } else if (action === 'compatibility') {
    const project = identifier(option(args, '--project')).toLowerCase();
    noExtra(args);
    path = `/api/idam/projects/${project}/compatibility/`;
    message = 'Declared dependencies reviewed, not execution-tested. No findings is not a compatibility pass. No code changes, model calls or credit reservations were made. Review before sharing project metadata.';
  } else if (action === 'memory-show' || action === 'memory-save' || action === 'memory-clear') {
    const project = identifier(option(args, '--project'));
    path = `/api/idam/projects/${project}/memory/`;
    if (action === 'memory-show') {
      noExtra(args);
      message = 'Your private project guidance. Review before sharing this output.';
    } else {
      const version = option(args, '--expected-version');
      if (!version || !/^(0|[1-9][0-9]{0,15})$/.test(version) || !Number.isSafeInteger(Number(version)) || Number(version) >= Number.MAX_SAFE_INTEGER) {
        throw new CliError('Use --expected-version from memory-show. A changed saved version requires another review.', EXIT.usage, 'guidance_version_required');
      }
      if (option(args, '--confirm') !== project) throw new CliError('Repeat the project UUID with --confirm to change your guidance for future tasks.', EXIT.usage, 'confirmation_required');
      const file = action === 'memory-save' ? option(args, '--file') : undefined;
      noExtra(args);
      body = { expected_version: Number(version), content: action === 'memory-save' ? await readProjectGuidance(file) : '' };
      method = 'PUT';
      message = action === 'memory-save'
        ? 'Guidance saved for your future tasks with the model. Project permissions and hosting limits are unchanged.'
        : 'Guidance cleared for future tasks. Existing task copies and backups are not erased.';
    }
  } else if (action === 'start') {
    const file = option(args, '--request');
    noExtra(args);
    body = await readAssistantRequest(file);
    path = '/api/idam/tasks/';
    message = 'Task accepted. Check its status; acceptance does not mean work has completed.';
  } else if (action === 'sources') {
    const project = identifier(option(args, '--project'));
    noExtra(args);
    path = `/api/idam/projects/${project}/research-sources/`;
    message = 'Reviewed public excerpts, not a live search. Select up to four IDs in research_source_ids for a research request. Source text counts toward the credit estimate; availability is checked again before work starts.';
  } else if (action === 'list') {
    const project = identifier(option(args, '--project'));
    noExtra(args);
    path = `/api/idam/tasks/?project_id=${project}`;
    message = 'Your assistant tasks for this project.';
  } else if (['workflow-plan', 'workflow-start', 'workflow-revise', 'workflow-approve', 'workflow-status', 'workflow-cancel'].includes(action ?? '')) {
    const id = identifier(args.shift());
    if (action === 'workflow-status') {
      path = `/api/idam/workflows/${id}/`;
      message = 'Connected review loaded. Open each linked task to inspect its draft and credit record.';
    } else {
      if (option(args, '--confirm') !== id) throw new CliError('Repeat the exact task or workflow ID with --confirm.', EXIT.usage, 'confirmation_required');
      if (action === 'workflow-revise' || action === 'workflow-approve') {
        const version = planVersion(args);
        const file = action === 'workflow-revise' ? option(args, '--request') : undefined;
        noExtra(args);
        path = `/api/idam/workflows/${id}/${action === 'workflow-approve' ? 'approve/' : ''}`;
        method = action === 'workflow-revise' ? 'PATCH' : 'POST';
        body = { ...(action === 'workflow-revise' ? await readWorkflowPlan(file) : {}), ...version };
        message = action === 'workflow-revise'
          ? 'Revised draft saved. Inspect workflow-status and approve the new saved version before follow-ups can start.'
          : 'Plan approval recorded. Follow-ups can start within the saved limits after each prior step finishes. Inspect workflow-status; approval does not mean work has completed.';
      } else if (action === 'workflow-plan' || action === 'workflow-start') {
        const ceiling = option(args, '--maximum-units');
        if (!ceiling || !/^[1-9][0-9]{0,3}$/.test(ceiling) || Number(ceiling) < 161 || Number(ceiling) > 2000) {
          throw new CliError('Set --maximum-units (161–2000) to cover the original task limit plus 160 additional credits. Inspect ai status first.', EXIT.usage, 'workflow_budget_invalid');
        }
        path = `/api/idam/tasks/${id}/workflow/`;
        body = { steps: [{ mode: 'diagnose', model: 'gpt-5.6-luna', maximum_units: 80 },
          { mode: 'review', model: 'gpt-5.6-luna', maximum_units: 80 }],
          maximum_units: Number(ceiling), maximum_context_units: 200000 };
        message = 'Draft plan saved, not approved. Your original task continues independently; no follow-up credits were reserved. Inspect workflow-status, revise if needed, then use workflow-approve with the saved revision and digest. No tests, source edits or deployment were requested.';
      } else {
        path = `/api/idam/workflows/${id}/cancel/`;
        body = {};
        message = 'Sequence stop recorded. Later steps will not start; already dispatched work may incur usage. Inspect each task for remaining reservations.';
      }
    }
    noExtra(args);
  } else {
    if (!action || !['status', 'events', 'export', 'review', 'approve', 'rollback-review', 'rollback-approve', 'cancel', 'resume'].includes(action)) {
      throw new CliError('Use ai start, list, sources, status, events, export, review, approve, rollback-review, rollback-approve, cancel, resume, workflow-plan, workflow-revise, workflow-approve, workflow-status, workflow-cancel, compatibility, starters, starter-review, starter-status, starter-approve, build-modules, build-review, build-status, build-approve, memory-show, memory-save or memory-clear. See blinkhost docs ai.', EXIT.usage, 'unknown_action');
    }
    const id = identifier(args.shift());
    path = `/api/idam/tasks/${id}/`;
    message = 'Assistant task loaded.';
    if (action === 'export') {
      const sourceIndex = args.indexOf('--include-source');
      const includeSource = sourceIndex >= 0;
      if (includeSource) args.splice(sourceIndex, 1);
      path += `export/${includeSource ? '?include_source=1' : ''}`;
      message = 'Private task snapshot exported. Review before sharing; this is not a project backup or proof of deployment.';
    } else if (action === 'review') {
      const paths: string[] = [];
      while (args.includes('--path')) paths.push(option(args, '--path')!);
      if (paths.length > 20) throw new CliError('Review at most 20 paths at a time.', EXIT.usage, 'selection_invalid');
      body = paths.length ? { paths } : {};
      path += 'review/';
      message = 'Compare these exact changes before approving. No source has been changed.';
    } else if (action === 'rollback-review') {
      body = {};
      path += 'rollback/review/';
      message = 'Review each file to restore or delete before approving this undo. No source has been changed.';
    } else if (action === 'approve' || action === 'rollback-approve' || action === 'cancel' || action === 'resume') {
      const confirmation = option(args, '--confirm');
      if (confirmation !== id) throw new CliError(`Repeat the task ID with --confirm to ${action} this task.`, EXIT.usage, 'confirmation_required');
      if (action === 'approve' || action === 'rollback-approve') {
        const value = option(args, '--digest');
        if (!value || !digest.test(value)) throw new CliError('Pass the action_digest from the review you inspected.', EXIT.usage, 'review_digest_required');
        body = { action_digest: value };
        path += action === 'rollback-approve' ? 'rollback/apply/' : 'apply/';
        message = action === 'rollback-approve'
          ? 'Source undo recorded. This does not undo a deployment or change charges. Check your workspace before building or publishing.'
          : 'Source save recorded. Check the task and workspace for later edits or an undo. Build, test and preview before publishing.';
      } else {
        body = {};
        path += `${action}/`;
        message = action === 'resume'
          ? 'Continuation requested for the existing task within its original credit limit. Active work and retry delays are preserved. Inspect status for progress; this does not restart a stopped task or approve changes.'
          : 'Stop request recorded. Unknown provider usage may remain reserved until reconciled.';
      }
    }
    noExtra(args);
  }
  const client = await ApiClient.create(profile);
  const result = await client.request(path, body === undefined ? {} : { method, body: JSON.stringify(body) });
  if (moduleBuildExpected) validateModuleBuild(result, moduleBuildExpected, action!);
  if (starterExpected) validateStarter(result, starterExpected, action!);
  if (action === 'resume') {
    const response = result as { task?: { id?: unknown; status?: unknown; maximum_units?: unknown }; continuation?: unknown } | null;
    if (!response || typeof response !== 'object'
      || !response.task || typeof response.task !== 'object'
      || response.task.id !== path.split('/')[4]
      || !['queued', 'running'].includes(String(response.task.status))
      || !Number.isSafeInteger(response.task.maximum_units) || Number(response.task.maximum_units) < 1
      || !['requested', 'already_scheduled'].includes(String(response.continuation))) {
      throw new CliError('The continuation response could not be verified. Check ai status before deciding whether to try again; do not retry automatically.', EXIT.remote, 'continuation_response_invalid');
    }
    if (response.continuation === 'already_scheduled') {
      message = 'This task is already running or scheduled. No additional work was queued. Check ai status for progress; its original credit limit remains unchanged.';
    }
  }
  if (action === 'compatibility') validateCompatibility(result, path.split('/')[4]!);
  if (action === 'sources') validateResearchCatalog(result, path.split('/')[4]!);
  if (action?.startsWith('memory-')) {
    const memory = result as Record<string, unknown> | null;
    if (!memory || typeof memory !== 'object' || memory.project_id !== path.split('/')[4]
      || !Number.isSafeInteger(memory.version) || Number(memory.version) < 0
      || typeof memory.content !== 'string' || Buffer.byteLength(memory.content) > 4096
      || memory.max_bytes !== 4096 || memory.trust !== 'untrusted_user_guidance' || memory.visibility !== 'requester_private'
      || (memory.updated_at !== null && (typeof memory.updated_at !== 'string' || !Number.isFinite(Date.parse(memory.updated_at))))
      || (body && (memory.content !== body.content || Number(memory.version) < Number(body.expected_version)
        || Number(memory.version) > Number(body.expected_version) + 1))) {
      throw new CliError('The saved guidance could not be verified. Run memory-show and compare the saved version before making another change. Do not retry a write automatically.', EXIT.remote, 'guidance_response_invalid');
    }
  }
  if (action === 'events' && result && typeof result === 'object') {
    return { message: 'Task activity loaded.', data: (result as { events?: unknown }).events ?? [] };
  }
  // Export writes only to the command's normal output; no implicit local files,
  // source edits, model calls, retries, package execution or worker access.
  return { message, data: result };
}
