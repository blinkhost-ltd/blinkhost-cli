import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialStoreStatus } from './credentials.js';
import { SUPPORTED_FRONTENDS, SUPPORTED_MANAGERS, SUPPORTED_MODULES } from './manifest.js';
import { resolveLocalPath, validateProject } from './project.js';
import { DOCUMENTATION_URL, RELEASES_URL, VERSION, supportedNodeVersion } from './version.js';

export interface DocumentationTopic {
  name: string;
  title: string;
  summary: string;
  usage: string[];
  details: string[];
  examples: string[];
  related: string[];
  url: string;
}

const resource = (name: string, summary: string, extra: string[] = []): DocumentationTopic => ({
  name,
  title: `${name[0]!.toUpperCase()}${name.slice(1)} commands`,
  summary,
  usage: [
    `blinkhost ${name} list [--query name=value]`,
    `blinkhost ${name} get ID`,
    `blinkhost ${name} create --data @request.json`,
    `blinkhost ${name} update ID --data @request.json`,
    `blinkhost ${name} delete ID --confirm ID`,
    `blinkhost ${name} action ID ACTION --data @request.json`,
  ],
  details: [
    'List and get are read-only. Create, update, delete and action send remote requests to the active BlinkHost workspace.',
    'Workspace roles, plan limits, protected-environment approvals, verified-artifact requirements and audit records remain enforced by BlinkHost.',
    'Deletion requires the exact resource ID through --confirm. JSON request files must be regular files no larger than 1 MiB.',
    ...extra,
  ],
  examples: [`blinkhost ${name} list --json`, `blinkhost ${name} get RESOURCE_ID --json`],
  related: ['auth', 'automation', 'limits', 'troubleshooting'],
  url: DOCUMENTATION_URL,
});

const TOPICS: Record<string, DocumentationTopic> = {
  ai: {
    name: 'ai', title: 'Idam assistant — staff preview', summary: 'Inspect tasks and explicitly review source proposals through the BlinkHost control plane.',
    usage: ['blinkhost ai start --request @request.json', 'blinkhost ai list --project PROJECT_UUID',
      'blinkhost ai status|events TASK_UUID', 'blinkhost ai export TASK_UUID [--include-source]', 'blinkhost ai review TASK_UUID [--path src/file.ts]',
      'blinkhost ai approve TASK_UUID --digest REVIEW_ACTION_DIGEST --confirm TASK_UUID',
      'blinkhost ai rollback-review TASK_UUID', 'blinkhost ai rollback-approve TASK_UUID --digest UNDO_ACTION_DIGEST --confirm TASK_UUID',
      'blinkhost ai workflow-plan TASK_UUID --maximum-units TOTAL_LIMIT --confirm TASK_UUID',
      'blinkhost ai workflow-revise WORKFLOW_UUID --request @plan.json --expected-revision VERSION --digest PLAN_DIGEST --confirm WORKFLOW_UUID',
      'blinkhost ai workflow-approve WORKFLOW_UUID --expected-revision VERSION --digest PLAN_DIGEST --confirm WORKFLOW_UUID',
      'blinkhost ai workflow-status WORKFLOW_UUID', 'blinkhost ai workflow-cancel WORKFLOW_UUID --confirm WORKFLOW_UUID',
      'blinkhost ai memory-show --project PROJECT_UUID',
      'blinkhost ai compatibility --project PROJECT_UUID',
      'blinkhost ai sources --project PROJECT_UUID',
      'blinkhost ai memory-save --project PROJECT_UUID --file @guidance.txt --expected-version VERSION --confirm PROJECT_UUID',
      'blinkhost ai memory-clear --project PROJECT_UUID --expected-version VERSION --confirm PROJECT_UUID',
      'blinkhost ai cancel TASK_UUID --confirm TASK_UUID',
      'blinkhost ai resume TASK_UUID --confirm TASK_UUID',
      'blinkhost ai starters --project PROJECT_UUID',
      'blinkhost ai starter-review --project PROJECT_UUID --name api --language LANGUAGE_ID --revision SOURCE_REVISION --request-id REQUEST_UUID',
      'blinkhost ai starter-status REVIEW_UUID --project PROJECT_UUID',
      'blinkhost ai starter-approve REVIEW_UUID --project PROJECT_UUID --digest ACTION_DIGEST --confirm REVIEW_UUID',
      'blinkhost ai build-modules --project PROJECT_UUID',
      'blinkhost ai build-review --project PROJECT_UUID --module MODULE_UUID --revision SOURCE_REVISION --request-id REQUEST_UUID',
      'blinkhost ai build-status REVIEW_UUID --project PROJECT_UUID',
      'blinkhost ai build-approve REVIEW_UUID --project PROJECT_UUID --digest ACTION_DIGEST --confirm REVIEW_UUID'],
    details: ['Not customer-enabled yet. This command does not reach the private model worker directly. Workspace membership, pilot access and server billing limits still apply.',
      'starters and starter-status require ai:read. starter-review requires ai:execute and prepares files from the current platform template without saving them. Retain a stable request UUID; use the current revision and language ID from starters. Inspect every returned file before starter-approve (ai:approve), using the exact review UUID and action digest. Saving adds a backend module through normal project limits; it does not overwrite source, call a model, build, commit or publish. Source, permissions, template and policy are checked again. Reviews expire after 15 minutes. Save the review UUID before approval. If the response is lost or invalid, use starter-status with that same UUID; never repeat an uncertain save automatically. A withdrawn template can hide its preview while keeping its historical save receipt. A receipt remains historical after later edits or module deletion and never recreates source. These commands are unreleased and staff-only.',
      'sources requires ai:read and lists reviewed public-document excerpts only; it does not search or fetch the web. In a research-mode request, research_source_ids can select up to four unique IDs from this catalog. Review attribution, capture date and review due date. Source text counts toward the credit estimate; expired or withdrawn sources stop queued work before model dispatch. Inspect status or export for the original excerpts and whether the model referenced each. A citation is not independent verification of a conclusion. Availability has a separate staff gate and is off by default.',
      'compatibility requires ai:read and reviews saved project declarations without uploads, model calls, credit reservations or code execution. Findings retain manifest paths and dependency sections, with revision and inspection limits. Fixed npm and Python name rules inspect package.json and single-line requirements.txt declarations; aliases, imports, versions and transitives are not resolved. Python markers/extras are not evaluated; includes, URLs and pip options are not followed. Other manifest formats need manual review. No findings is not a compatibility pass. Development dependencies do not necessarily run on the backend. WASM-only backend limits still apply. Review metadata before sharing output and rerun after changes. This is not an adaptation, build, test, preview or deployment command.',
      'Sign in with explicit scopes: auth login --scope ai:read --scope ai:execute --scope ai:approve. account:read is included for session checks. Other scopes must be requested separately when using --scope. Existing sessions do not gain AI permissions automatically. Workload identities cannot use this personal staff preview, even if their token lists AI scopes.',
      'Project guidance is optional, private to your own tasks, and sent to the model as unverified user context. memory-show requires ai:read and prints private text to normal output. Review that version before memory-save or memory-clear (ai:execute), using --expected-version and --confirm PROJECT_UUID. Saving uploads one explicitly selected regular UTF-8 text file of at most 4 KiB; symlinks, empty text and unsupported control characters are refused. Keep credentials out; screening is not exhaustive. No automatic write retries: after a timeout or conflict, run memory-show, compare the saved text/version, then decide whether to submit a new write. Guidance never grants permissions, changes hosting support or bypasses billing. Editing or clearing stops queued tasks and later workflow steps using old guidance; already dispatched work can finish. Clearing keeps a version fence and does not erase copies in task history or backups. Project transfers cannot carry guidance into another organization. These commands remain unreleased.',
      'A start request is a regular UTF-8 JSON file of at most 16 KiB containing project_id, client_request_id (stable UUID), prompt, and maximum_units (1–2000); mode and model are optional. Keep credentials out of prompts. Reuse the same file and client_request_id only for a retry of the same request. Choose a new UUID for a new task.',
      'The preview uses structural metadata by default. To authorize sharing saved workspace files with Azure OpenAI for this task, add source_paths: an array of up to eight unique project-relative paths. Each file must be at most 16 KiB and all selected files at most 24 KiB; the encoded context limit may reduce this. No local files are uploaded and production data is excluded. Review files first: credential screening is not exhaustive. Task status lists the selected paths. Generated source is unverified. It cannot browse, run tests or deploy.',
      'Review returns annotated diffs and an action_digest bound to the original source. Invisible controls appear as [U+…] markers; newline annotations are also display-only, not an executable patch. JSON output escapes terminal controls without changing decoded values. Approval requires the digest and explicit task confirmation. A changed project, policy, selection or expired review requires fresh review. Saving source neither creates a Git commit nor builds or publishes it.',
      'rollback-review prepares an undo of the originally saved files. Inspect every restore and delete operation, then use rollback-approve with its new action_digest and --confirm TASK_UUID. Preparing needs ai:execute; applying needs ai:approve. Later edits to affected files block undo; any workspace edit after review requires a fresh review. Reviews expire after 15 minutes. New files are removed only if unchanged and not open for live editing; folders and other files are kept. There is no force option. Original source must still be retained. Undo is source-only: it does not reverse deployments, Git commits or charges. Duplicate approval does not overwrite later edits. Check task status after a timeout; no automatic retries.',
      'There is no automatic resubmission after a timeout. Use list/status to inspect state. Usage with an unknown outcome remains reserved, including after cancellation.',
      'blinkhost ai resume TASK_UUID --confirm TASK_UUID requires ai:execute and asks an eligible multi-step task to continue from its saved checkpoint. It preserves the original task, credit limit, active work, retry delays and usage records. It does not restart completed, cancelled, stopped or usage-reconciliation tasks, approve source changes, or increase spending. Current access, project revision and saved guidance must still match. No automatic retries: inspect status after a timeout. This command is unreleased and staff-only.',
      'Build commands operate on saved WASM backend modules, not unsaved IDE edits or native server frameworks. build-modules and build-status need ai:read. build-review needs ai:execute, a current source revision and a UUID request-id you retain for reconciliation; preparation stores a review only and does not upload source or start compilation. Inspect the saved source, module, source digest, expiry and usage policy. build-approve needs ai:approve, the exact action digest and review confirmation. It requests one normal metered build, including configured overages and duration usage, with no AI credits. It never promotes an artifact, commits source or publishes. After a timeout use build-status with the same review ID; never start another review to retry an uncertain build. Approvals expire after 15 minutes and source, access, compiler availability and current policy are rechecked. A successful receipt is not a successful compilation; inspect the build state and IDE diagnostics. Commands are unreleased and staff-only.',
      'Connected reviews have a separate disabled-by-default staff gate. For an existing plan, diagnose or review task, inspect its maximum_units using status, then workflow-plan with a total limit covering that original cap plus 160 credits (80 for investigation, 80 for review), at most 2000 total. workflow-start is a compatibility alias: it now saves a draft, never approves it. The original task continues independently. Saving, editing and approving a plan do not grant or reserve additional credits. Each later step rechecks access, source revision and available credits. No builds, tools, source changes or deployment are authorized.',
      'Inspect workflow-status for the saved steps, limits, plan_revision, plan_digest and version history. workflow-revise accepts a regular UTF-8 JSON file up to 16 KiB with exactly steps, maximum_units and maximum_context_units. Use one to three steps, each with mode (plan, diagnose or review), model (gpt-5.6-luna, gpt-5.6-terra or gpt-5.6-sol) and maximum_units (1–2000). The total must cover the original task cap plus all steps, at most 2000; the context limit is 1–393216 conservative units, not measured provider tokens. Pass the inspected revision/digest and exact workflow confirmation to revise or approve. Each changed save creates a new version (up to 100); approval binds the exact saved version. Approved and stopped plans cannot be edited or resumed. After a timeout inspect status before any manual retry; do not reuse stale approval. workflow-status needs ai:read; plan, revise and cancel need ai:execute; workflow-approve needs ai:approve. Plan approval never grants source-write authority. Follow-ups retain the original request and previous draft under their own task retention; removing one does not erase copies in another. Version history keeps metadata, not prompt/source/result bodies. Stopping prevents later steps, not charges for dispatched work. Commands remain unreleased.',
      'export prints a versioned, private task snapshot (blinkhost.idam.task-export/v1) to normal output. Use --json for machine-readable output. Proposed source-file copies require --include-source; input files, internal context, tool receipts and approval tokens are never included. Requests and narrative may still contain private information. Review before sharing. Removed content stays removed, and history above 1,000 events is explicitly marked partial. Downloads are not project backups or proof of deployment, and task-history removal cannot erase existing downloads. Exports over 4 MiB are refused, not silently cut short.'],
    examples: ['blinkhost docs ai', 'blinkhost ai start --request @request.json --json', 'blinkhost ai status TASK_UUID --json'],
    related: ['auth', 'security', 'projects', 'builds'], url: DOCUMENTATION_URL,
  },
  quickstart: {
    name: 'quickstart', title: 'Safe first steps', summary: 'Inspect local readiness and receive a non-destructive path to your first BlinkHost project.',
    usage: ['blinkhost quickstart [path]', 'blinkhost quickstart [path] --json'],
    details: ['Quickstart performs local checks only. It does not sign in, create cloud resources, deploy, upload source, or incur usage.', 'Use create for a new project or init to adopt an existing repository. Review blinkhost.yaml before linking a remote project.'],
    examples: ['blinkhost quickstart', 'blinkhost create my-app --template astro --no-install', 'blinkhost init ./existing-app'], related: ['create', 'init', 'doctor', 'auth'], url: DOCUMENTATION_URL,
  },
  create: {
    name: 'create', title: 'Create a local project', summary: 'Generate an atomic BlinkHost project scaffold without changing remote resources.',
    usage: ['blinkhost create NAME [--template FRAMEWORK] [--package-manager MANAGER] [--module NAME:LANGUAGE] [--database BINDING] [--install|--no-install]'],
    details: [`Frameworks: ${SUPPORTED_FRONTENDS.join(', ')}.`, `Package managers: ${SUPPORTED_MANAGERS.join(', ')}.`, `Backend module languages: ${SUPPORTED_MODULES.join(', ')}.`, 'The default template is react and the default package manager is npm. Existing paths are never overwritten. Dependency lifecycle scripts are disabled during installation.', 'Creation is local only; it does not create a BlinkHost project, database, preview, deployment, or billable resource.'],
    examples: ['blinkhost create my-app --template astro', 'blinkhost create my-app --template react --module api:rust --module jobs:python --database APP_DB --no-install'], related: ['quickstart', 'validate', 'projects', 'manifest-reference'], url: DOCUMENTATION_URL,
  },
  init: {
    name: 'init', title: 'Adopt an existing repository', summary: 'Detect supported project metadata and write a reviewable blinkhost.yaml.',
    usage: ['blinkhost init [path] [--dry-run|--force]'],
    details: ['Detection reads package.json dependencies and the pnpm, Yarn, Bun or npm lockfile at the selected application root. It recognizes Astro, React, Vue, Svelte and Solid; a directory without recognized framework metadata is described as static HTML.', '`--dry-run` returns the proposed manifest and writes nothing. Without it, init writes only blinkhost.yaml and refuses an existing manifest. `--force` replaces only an existing regular blinkhost.yaml after explicit use; application source and configuration are never rewritten.', 'Detection proposes modules only from safe, regular blinkhost.toml files under _server_islands. Review every detected module before validation; other backend directories are never silently registered.', 'One manifest represents one deployable application. For a nested app, pass that directory. For a workspace app that imports shared packages, place the manifest at a root containing the complete build context and set frontend.root and frontend.dependency_root explicitly. Use separate application roots and BlinkHost projects for independently deployable monorepo applications.'],
    examples: ['blinkhost init . --dry-run --json', 'blinkhost init apps/storefront', 'blinkhost docs manifest-reference'], related: ['validate', 'manifest-reference', 'projects'], url: DOCUMENTATION_URL,
  },
  validate: {
    name: 'validate', title: 'Validate project compatibility', summary: 'Check the manifest, declared files, path safety and dependency metadata without building or uploading.',
    usage: ['blinkhost validate [path]'],
    details: ['Validation rejects unknown fields, duplicate YAML keys, aliases, traversal, unsafe symbolic links, reserved cross-platform paths, duplicate modules and missing declared inputs.', 'Warnings identify non-blocking portability or reproducibility concerns such as a missing lockfile.'],
    examples: ['blinkhost validate', 'blinkhost validate apps/storefront --json'], related: ['manifest-reference', 'doctor', 'test'], url: DOCUMENTATION_URL,
  },
  manifest: {
    name: 'manifest', title: 'Read the normalized project manifest', summary: 'Parse and print blinkhost.yaml after applying its strict schema rules.',
    usage: ['blinkhost manifest [path]'], details: ['Use --json to wrap the normalized manifest in the stable CLI response envelope. Secret values are never valid manifest fields.'], examples: ['blinkhost manifest --json'], related: ['manifest-reference', 'validate'], url: DOCUMENTATION_URL,
  },
  doctor: {
    name: 'doctor', title: 'Check the local toolchain', summary: 'Verify Node.js, Git, the selected directory and its BlinkHost manifest.',
    usage: ['blinkhost doctor [path]'], details: ['Doctor is local and non-destructive. Quickstart additionally explains authentication prerequisites and next steps.'], examples: ['blinkhost doctor . --json'], related: ['quickstart', 'validate', 'portability'], url: DOCUMENTATION_URL,
  },
  test: {
    name: 'test', title: 'Run project checks', summary: 'Validate the project and run its test script, or its build script when no test script exists.',
    usage: ['blinkhost test [path]'], details: ['Static HTML projects require validation only. JavaScript dependencies must be installed first.', 'With --json, stdout contains exactly one JSON response; child-process diagnostics are sent to stderr.'], examples: ['blinkhost test .', 'blinkhost test . --json'], related: ['validate', 'automation', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
  auth: {
    name: 'auth', title: 'Authentication and sessions', summary: 'Connect a device through browser approval and manage its CLI sessions.',
    usage: ['blinkhost auth login [--no-browser] [--api-origin URL] [--scope PERMISSION]', 'blinkhost auth status', 'blinkhost auth sessions', 'blinkhost auth revoke SESSION_ID', 'blinkhost auth logout'],
    details: ['Passwords are never entered in the terminal. Refresh credentials are stored only in macOS Keychain, Windows Password Vault, or Linux Secret Service through secret-tool.', 'Headless automation should use a registered GitHub OIDC workload or a short-lived BLINKHOST_ACCESS_TOKEN supplied by an approved CI secret service. Never persist it in source or CLI configuration.', '--non-interactive prevents browser authorization and fails closed when interaction would be required.'],
    examples: ['blinkhost auth login', 'blinkhost auth login --no-browser', 'blinkhost auth sessions --json'], related: ['profile', 'ci', 'security', 'portability'], url: DOCUMENTATION_URL,
  },
  profile: {
    name: 'profile', title: 'Account profiles', summary: 'Keep personal and work BlinkHost sessions separate.',
    usage: ['blinkhost profile list', 'blinkhost profile use NAME'], details: ['--profile NAME selects a profile for one command. BLINKHOST_PROFILE selects a default for the current process. Profile names contain lowercase letters, numbers, hyphens or underscores.'], examples: ['blinkhost auth login --profile work', 'blinkhost profile use work'], related: ['auth', 'security'], url: DOCUMENTATION_URL,
  },
  projects: {
    ...resource('projects', 'Manage projects and explicit local project links.'),
    usage: [...resource('projects', '').usage, 'blinkhost projects export PROJECT_UUID --output ./project.zip'],
    details: [...resource('projects', '').details,
      'projects link/unlink manage only the local pointer. projects pull/push synchronize through a configured source connection.',
      'projects export downloads a source ZIP through the existing project export service. Requires projects:read and an owner, admin or developer role. A GitHub connection is not required.',
      'The CLI accepts archives up to 32 MiB, never overwrites files, follows no download redirects, and does not extract or run source. Use a new .zip path in an existing directory without symbolic links. The file is private to your account where POSIX permissions apply.',
      'This exports source and portable configuration, not database rows, runtime secret values, deployed artifacts or complete Git history. Review before sharing: secret screening is not a guarantee. Recreate bindings and resources separately and validate runtime compatibility at the destination. ai export is a separate task-history snapshot.'],
  },
  repositories: resource('repositories', 'Inspect and manage connected source repositories.'),
  connections: resource('connections', 'Manage project-to-repository source connections.'),
  previews: resource('previews', 'Manage temporary preview environments.', ['`previews wait ID [--timeout 10..3600]` waits for a terminal state. `previews open ID` accepts only trusted BlinkHost HTTPS preview hosts. Preview operations can consume plan resources.']),
  builds: resource('builds', 'Create, inspect and wait for verified builds.', ['`builds wait ID [--timeout 10..3600]` stops on success, failure, cancellation, expiry or timeout. Builds can consume plan resources.']),
  deployments: resource('deployments', 'Manage production deployments and protected release actions.', ['Rollback uses `deployments action DEPLOYMENT_ID rollback --data @rollback.json`. Protected environments can require approval and a verified artifact. Deployment operations can consume plan resources.']),
  modules: resource('modules', 'Manage Rust, Go, Python, JavaScript and TypeScript Functions.'),
  functions: {
    name: 'functions', title: 'Function triggers and runs', summary: 'Manage beta event, schedule and background triggers with explicit retry and idempotency controls.',
    usage: ['blinkhost functions status [PROJECT_ID]', 'blinkhost functions triggers list MODULE_ID', 'blinkhost functions triggers create MODULE_ID --data @trigger.json', 'blinkhost functions triggers update MODULE_ID TRIGGER_ID --data @trigger.json', 'blinkhost functions triggers delete MODULE_ID TRIGGER_ID --confirm TRIGGER_ID', 'blinkhost functions invoke run MODULE_ID TRIGGER_ID --data @payload.json [--idempotency-key KEY]', 'blinkhost functions invocations list MODULE_ID', 'blinkhost functions invocations get|result|cancel MODULE_ID INVOCATION_ID', 'blinkhost functions invocations retry MODULE_ID INVOCATION_ID [--idempotency-key KEY]'],
    details: ['Event, schedule and background triggers are beta capabilities and may be enabled progressively by workspace. Workspace roles, runtime policy, verified artifacts, plan limits and the service rollout gate remain authoritative.', 'Payloads must be JSON objects no larger than 256 KiB. Results are bounded by the service. Use a stable idempotency key when repeating the same logical request; otherwise the CLI generates one for each submission.', 'Delivery is at least once. Handlers that can create duplicate writes, messages or charges must be idempotent. Cancellation cannot undo application work that has already completed.'],
    examples: ['blinkhost functions status PROJECT_ID --json', 'blinkhost functions triggers list MODULE_ID --json', 'blinkhost functions invoke run MODULE_ID TRIGGER_ID --data @payload.json --idempotency-key order-1042 --json'], related: ['modules', 'automation', 'limits', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
  databases: resource('databases', 'Manage database resources.', ['Database list, get, create, update, delete and supported server actions are remote and may require plan capacity or protected-environment approval.', 'The CLI does not invent local backup, restore, credential-rotation or migration semantics. Use only actions returned by the active workspace API and consult the detailed database guide before production data changes. Deletion retains exact-ID confirmation and server authorization.']),
  bindings: resource('bindings', 'Manage explicit application-to-resource bindings.'),
  assets: resource('assets', 'Manage project assets.', ['Upload with `assets upload FILE --project PROJECT_ID [--parent ID] [--revision VALUE] [--replace ID]`. Uploads accept listed image, font, MP3 and MP4 types, reject symbolic links, verify SHA-256 and count against plan storage.']),
  organizations: resource('organizations', 'Manage organizations within the permissions granted to your account.'),
  templates: resource('templates', 'Inspect and manage verified source templates.'),
  approvals: resource('approvals', 'Inspect and act on deployment approvals within your role.'),
  handoffs: resource('handoffs', 'Manage explicit agency handoffs and their audit trail.'),
  policies: resource('policies', 'Inspect and manage enterprise policies within authorized workspaces.'),
  workloads: resource('workloads', 'Register narrowly scoped automation identities.', ['Use an exact GitHub branch, tag or protected-environment subject. Workload tokens are short-lived and do not replace workspace authorization.']),
  secrets: {
    name: 'secrets', title: 'Project secrets', summary: 'List, set, rotate and delete secret records without placing values in arguments.',
    usage: ['blinkhost secrets list --project PROJECT_ID', "printf '%s' \"$VALUE\" | blinkhost secrets set NAME --project PROJECT_ID [--environment SCOPE] [--expires-in-days DAYS]", "printf '%s' \"$VALUE\" | blinkhost secrets rotate SECRET_ID", 'blinkhost secrets delete SECRET_ID --confirm SECRET_ID'],
    details: ['Values are read only from standard input, limited to 64 KiB and never written to blinkhost.yaml. Disable shell tracing around secret input and use masked variables or an approved secret manager in CI.', 'List responses do not return secret values. Authorization and workspace scope are enforced by the API.'], examples: ["set +x; printf '%s' \"$API_TOKEN\" | blinkhost secrets set API_TOKEN --project PROJECT_ID"], related: ['security', 'automation'], url: DOCUMENTATION_URL,
  },
  dev: {
    name: 'dev', title: 'Local development', summary: 'Run the manifest-declared frontend development process.', usage: ['blinkhost dev [path] [--host HOST] [--port PORT]'], details: ['This starts the local frontend process and sets BLINKHOST_LOCAL=1. It does not deploy a release. Static HTML projects should use a local static-file server.', 'Install dependencies first. Production bindings are not automatically exposed to local processes.'], examples: ['blinkhost dev . --host 127.0.0.1 --port 3000'], related: ['quickstart', 'test', 'previews'], url: DOCUMENTATION_URL,
  },
  logs: {
    name: 'logs', title: 'Project observability', summary: 'Read authorized logs, metrics or analytics for a linked or explicit project.', usage: ['blinkhost logs [--project ID] [--since DURATION] [--limit COUNT]', 'blinkhost metrics [--project ID] [--since DURATION]', 'blinkhost analytics [--project ID]'], details: ['These commands are read-only and access is workspace-scoped.', 'Treat application logs as potentially sensitive. The CLI does not claim that arbitrary secrets written by application code can always be detected or redacted, so review output before sharing it. Use the redacted support bundle for platform diagnostics.', 'The service remains authoritative for retention, pagination, platform-managed filtering and audit access. Do not deliberately log credentials or personal data.'], examples: ['blinkhost logs --project PROJECT_ID --since 1h --limit 100 --json'], related: ['security', 'support', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
  metrics: { name: 'metrics', title: 'Project metrics', summary: 'Read authorized metrics for a project.', usage: ['blinkhost metrics [--project ID] [--since DURATION]'], details: ['The command is read-only and accepts a linked project when --project is omitted.'], examples: ['blinkhost metrics --project PROJECT_ID --since 24h --json'], related: ['logs'], url: DOCUMENTATION_URL },
  analytics: { name: 'analytics', title: 'Project analytics', summary: 'Read authorized analytics for a project.', usage: ['blinkhost analytics [--project ID]'], details: ['The command is read-only and accepts a linked project when --project is omitted.'], examples: ['blinkhost analytics --project PROJECT_ID --json'], related: ['logs'], url: DOCUMENTATION_URL },
  support: {
    name: 'support', title: 'Redacted support bundles', summary: 'Create a local diagnostic inventory for support without including source or credentials.', usage: ['blinkhost support bundle [--output PATH]'], details: ['The file is created with mode 0600 and refuses to overwrite an existing path. It excludes tokens, secret values, source code, filenames and repository URLs.', 'Review the generated file before sharing it. The default filename is blinkhost-support-<timestamp>.json in the current directory.'], examples: ['blinkhost support bundle', 'blinkhost support bundle --output ./support.json'], related: ['security', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
  completion: {
    name: 'completion', title: 'Shell completion', summary: 'Generate deterministic completion for Bash, Zsh, Fish or PowerShell.', usage: ['blinkhost completion bash|zsh|fish|powershell'], details: ['The command prints a script to standard output; source or install it using your shell configuration.'], examples: ['source <(blinkhost completion bash)', 'blinkhost completion zsh > ~/.zfunc/_blinkhost'], related: ['portability'], url: DOCUMENTATION_URL,
  },
  update: {
    name: 'update', title: 'CLI releases and updates', summary: 'Compare this CLI version with the verified BlinkHost release registry and read its release notes.', usage: ['blinkhost update check', 'blinkhost update notes [VERSION]'], details: ['Update checks and notices never install software automatically. Interactive notices are cached for 48 hours and stay silent in CI, JSON output and non-interactive sessions.', 'Pin a version with `npm install --global @blinkhost/cli@VERSION`; roll back with the same command and an earlier reviewed version.'], examples: ['blinkhost update check --json', 'blinkhost update notes 2.4.0'], related: ['supply-chain'], url: DOCUMENTATION_URL,
  },
  ci: {
    name: 'ci', title: 'CI readiness', summary: 'Verify the active workload identity and server-reported CLI capabilities.', usage: ['blinkhost ci check'], details: ['GitHub Actions should use an exact registered OIDC subject and id-token: write. No long-lived BlinkHost token is required.', 'Other CI systems may provide a short-lived BLINKHOST_ACCESS_TOKEN from an approved secret service; never commit or print it.'], examples: ['blinkhost ci check --non-interactive --json'], related: ['automation', 'auth', 'workloads'], url: DOCUMENTATION_URL,
  },
  plugins: {
    name: 'plugins', title: 'Local CLI plugins', summary: 'Approve and run local executables with digest pinning and a restricted environment.', usage: ['blinkhost plugins list', 'blinkhost plugins add /absolute/path --name NAME', 'blinkhost plugins verify NAME', 'blinkhost plugins run NAME -- ARGS', 'blinkhost plugins remove NAME'], details: ['Plugins must be regular files, not symbolic links. BlinkHost records the SHA-256 digest and refuses changed executables until reviewed and added again.', 'Plugins receive only a small allowlist of process variables and never receive BlinkHost credentials. They still run with your operating-system account, so review them first.'], examples: ['blinkhost plugins verify formatter --json'], related: ['security'], url: DOCUMENTATION_URL,
  },
  api: {
    name: 'api', title: 'Advanced customer API access', summary: 'Call supported customer API routes when a dedicated command is unavailable.', usage: ['blinkhost api GET /api/customer/path/', 'blinkhost api POST /api/customer/path/ --data @request.json'], details: ['Internal, staff, authentication and secret-bearing mutation routes are blocked. Absolute URLs, traversal, encoded paths and unsupported methods are rejected.', 'Prefer dedicated commands because they provide stronger validation and clearer safety boundaries.'], examples: ['blinkhost api GET /api/sites/ --json'], related: ['automation', 'security'], url: DOCUMENTATION_URL,
  },
  automation: {
    name: 'automation', title: 'Automation contract', summary: 'Use deterministic output and short-lived identity safely from CI or coding agents.', usage: ['blinkhost COMMAND --json --non-interactive', 'blinkhost docs commands --json'], details: ['With --json, stdout is one JSON object for success or failure. Human and child-process diagnostics go to stderr. Exit codes, envelope fields and documented error codes remain stable within the v2 major line; service-specific data objects may add fields, so consumers must ignore unknown fields.', 'Mutating API requests carry a request ID and an idempotency key. A fresh key is generated for each CLI invocation. A timeout is not proof of failure: use the resource ID or request ID from output, list/get/status, and wait commands to reconcile state before starting a new mutation.', '`--non-interactive` prevents account authorization and preview commands from opening a browser. Never disable approvals, confirmation checks, workspace roles or plan controls in automation.'], examples: ['blinkhost validate . --json --non-interactive', 'blinkhost ci check --json --non-interactive'], related: ['exit-codes', 'ci', 'security', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
  security: {
    name: 'security', title: 'CLI security boundaries', summary: 'Understand credential, secret, plugin, path and remote-action safeguards.', usage: ['blinkhost docs security'], details: ['Passwords never enter the CLI. Refresh credentials require an operating-system credential service; CI uses short-lived identities.', 'Secret values enter only through stdin. Local project and payload files reject unsafe symbolic links and bounded inputs are enforced.', 'Remote roles, limits, approvals, verified artifacts and audit records remain server-enforced. CLI output must not be treated as a way around platform policy.'], examples: ['blinkhost auth sessions --json', 'blinkhost plugins verify NAME --json'], related: ['auth', 'secrets', 'plugins', 'supply-chain'], url: DOCUMENTATION_URL,
  },
  glossary: {
    name: 'glossary', title: 'BlinkHost terminology', summary: 'Translate platform terms into the developer actions they represent.', usage: ['blinkhost docs glossary'],
    details: ['Project: one deployable application and its resources. Module: a Rust, Go, Python, JavaScript or TypeScript Function declared by that project. Binding: an explicit connection between application code and a managed resource.', 'Preview: a temporary environment for reviewing a change. Build: compilation and verification of source. Deployment: promotion of a verified artifact to an environment.', 'Profile: a local named account configuration. Workload: a narrowly scoped short-lived automation identity. Approval: a required authorized decision before a protected action. Handoff: an audited transfer of agency or team responsibility.'],
    examples: ['blinkhost docs manifest-reference', 'blinkhost docs limits'], related: ['commands', 'manifest-reference'], url: DOCUMENTATION_URL,
  },
  portability: {
    name: 'portability', title: 'Supported environments', summary: 'Prepare Linux, macOS, Windows and headless automation environments.', usage: ['blinkhost quickstart --json'], details: ['Node.js 22.12 or newer is required on Linux, macOS and Windows. npm may warn rather than block an unsupported Node version, so the CLI checks again before operational commands.', 'macOS uses Keychain through the security command. Windows uses Password Vault through PowerShell. Linux uses Secret Service through secret-tool and requires an available desktop or session keyring.', 'Headless CI should use a registered GitHub OIDC workload or a short-lived access token supplied at runtime. Plaintext refresh-token storage is intentionally unsupported.', 'For offline installation, download the package archive, SHA256SUMS and Sigstore bundle on a connected machine; verify them, transfer all files through an approved channel, then run `npm install --global ./blinkhost-cli-VERSION.tgz --offline`.'], examples: ['node --version', 'blinkhost quickstart --json'], related: ['auth', 'ci', 'completion', 'supply-chain'], url: DOCUMENTATION_URL,
  },
  'manifest-reference': {
    name: 'manifest-reference', title: 'blinkhost.yaml reference', summary: 'Describe one application, frontend, backend modules and declared resources with schema blinkhost/v1.', usage: ['blinkhost manifest [path] --json', 'blinkhost validate [path] --json'], details: ['Top-level fields are schema, application, frontend, modules, resources, preview and ignore. Unknown fields are rejected.', `Frontend frameworks: ${SUPPORTED_FRONTENDS.join(', ')}. Package managers: ${SUPPORTED_MANAGERS.join(', ')}. Module languages: ${SUPPORTED_MODULES.join(', ')}.`, 'Paths are repository-relative POSIX paths. Values, aliases, traversal, symbolic-link escapes and platform-reserved segments are rejected. One manifest represents one BlinkHost application; use separate application roots and projects for multiple deployable applications in a monorepo.'], examples: ['blinkhost init apps/web', 'blinkhost validate apps/web --json'], related: ['init', 'validate', 'security'], url: DOCUMENTATION_URL,
  },
  limits: {
    name: 'limits', title: 'Limits and cost boundaries', summary: 'Separate local CLI work from server-enforced plan usage.', usage: ['blinkhost docs limits'], details: ['quickstart, create, init, validate, manifest, doctor, local test and local dev do not create BlinkHost cloud resources.', 'Remote previews, builds, deployments, databases, assets and modules can consume plan capacity. Exact quotas and prices come from the active workspace and current pricing page; the CLI does not guess or hard-code them.', 'Use list/get/status commands to inspect existing state before a mutation. Protected operations may require approval.'], examples: ['blinkhost projects status --json', 'blinkhost auth status --json'], related: ['quickstart', 'automation', 'deployments'], url: 'https://app.blinkhost.me/pricing',
  },
  troubleshooting: {
    name: 'troubleshooting', title: 'Failure and recovery guidance', summary: 'Recover safely from local, authentication, network and remote-operation failures.', usage: ['blinkhost doctor [path] --json', 'blinkhost support bundle'], details: ['Exit 2 means command usage, 3 validation, 4 local filesystem/tooling, 6 authentication/permission, 7 network/timeout, 8 remote failure, and 9 conflict or approval required.', 'The CLI does not automatically retry general remote mutations. Asset completion alone retries a temporary conflict for a bounded period. For a timeout, query the resource before retrying because the server may have completed the request; a new CLI invocation receives a new idempotency key.', 'Resume build, deployment or preview polling with `GROUP wait ID`; use list, get or status plus the request ID returned in an API error to reconcile uncertain state. There is no generic local resume for an interrupted upload or multi-resource sequence.', 'Missing dependencies: run the package manager install command, commit the lockfile, then retry test. Expired sessions: sign in again. Approval-required operations: complete the workspace approval rather than bypassing it.'], examples: ['blinkhost doctor . --json', 'blinkhost deployments get DEPLOYMENT_ID --json', 'blinkhost builds wait BUILD_ID --json'], related: ['support', 'automation', 'auth'], url: DOCUMENTATION_URL,
  },
  errors: {
    name: 'errors', title: 'Error and compatibility contract', summary: 'Interpret stable CLI failures without parsing human prose.', usage: ['blinkhost COMMAND --json --non-interactive', 'blinkhost docs exit-codes'], details: ['Failure JSON has ok=false, command, and error with code, message and details. Details may gain entries; automation should branch on error.code and the process exit code, not message text.', 'Usage errors use exit 2, project/input validation 3, local tooling 4, unexpected CLI failures 5, authentication/authorization 6, network/timeouts 7, remote-service failures 8, and conflicts or required approvals 9.', 'HTTP failures include a request ID in details for support correlation. Secret values, authorization headers and refresh credentials are never intentionally added to CLI errors. Child-process output is sent to stderr in JSON mode and can contain whatever the child tool emits, so do not run untrusted scripts or print secrets from build scripts.'], examples: ['blinkhost creat --json', 'blinkhost validate . --json'], related: ['exit-codes', 'automation', 'security'], url: DOCUMENTATION_URL,
  },
  'supply-chain': {
    name: 'supply-chain', title: 'Release verification', summary: 'Verify npm provenance or the signed GitHub release evidence.', usage: ['npm install --global @blinkhost/cli@VERSION'], details: ['Tagged releases publish from blinkhost-ltd/blinkhost-cli through the release.yml GitHub Actions workflow and npm Trusted Publishing.', 'Each GitHub release contains the package archive, CycloneDX SBOM, SHA256SUMS and SHA256SUMS.sigstore.json. Verify the checksum before installing an archive.', `Release evidence: ${RELEASES_URL}`], examples: ['sha256sum --check SHA256SUMS', `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity "https://github.com/blinkhost-ltd/blinkhost-cli/.github/workflows/release.yml@refs/tags/v${VERSION}" --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`], related: ['update', 'security'], url: RELEASES_URL,
  },
  'exit-codes': {
    name: 'exit-codes', title: 'Exit codes and JSON responses', summary: 'Build deterministic scripts around stable outcome categories.', usage: ['blinkhost COMMAND --json --non-interactive'], details: ['0 success; 2 invalid command or option; 3 project or input validation; 4 local filesystem or executable; 5 unexpected CLI failure; 6 authentication or permission; 7 network or timeout; 8 remote service failure; 9 state conflict or approval required.', 'JSON mode writes exactly one response object to stdout. The object contains ok, command, message and optional data or warnings on success, or ok, command and error with code, message and details on failure.'], examples: ['blinkhost validate . --json', 'blinkhost docs commands --json'], related: ['automation', 'troubleshooting'], url: DOCUMENTATION_URL,
  },
};

const COMMANDS = [
  'quickstart', 'docs', 'create', 'init', 'validate', 'manifest', 'doctor', 'test', 'auth', 'ai', 'profile', 'projects',
  'repositories', 'connections', 'previews', 'builds', 'deployments', 'modules', 'functions', 'databases', 'bindings', 'assets',
  'secrets', 'organizations', 'templates', 'approvals', 'handoffs', 'policies', 'workloads', 'dev', 'logs', 'metrics',
  'analytics', 'support', 'completion', 'update', 'ci', 'plugins', 'api',
] as const;

export const TOP_LEVEL_COMMANDS = [...COMMANDS];

export function documentationIndex(): { schema: string; cli_version: string; documentation_url: string; topics: Array<{ name: string; title: string; summary: string; url: string }> } {
  return {
    schema: 'blinkhost/cli-docs/v1', cli_version: VERSION, documentation_url: DOCUMENTATION_URL,
    topics: Object.values(TOPICS).map(({ name, title, summary, url }) => ({ name, title, summary, url })),
  };
}

export function documentationTopic(name: string): DocumentationTopic | undefined {
  if (name === 'commands' || name === 'docs') return {
    name: 'commands', title: 'Command reference', summary: 'Discover every top-level command in this CLI release.',
    usage: ['blinkhost COMMAND --help', 'blinkhost help COMMAND', 'blinkhost docs TOPIC', 'blinkhost docs --search TERM'],
    details: [`Commands: ${COMMANDS.join(', ')}.`, 'Use --json for a versioned machine-readable response and --non-interactive in automation.'],
    examples: ['blinkhost create --help', 'blinkhost docs automation --json'], related: ['quickstart', 'automation', 'exit-codes'], url: DOCUMENTATION_URL,
  };
  return TOPICS[name] ?? (['metrics', 'analytics'].includes(name) ? TOPICS.logs : undefined);
}

export function searchDocumentation(query: string): DocumentationTopic[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) return [];
  return Object.values(TOPICS).filter((topic) => JSON.stringify(topic).toLowerCase().includes(normalized));
}

export function renderTopic(topic: DocumentationTopic): string {
  const block = [`BlinkHost CLI ${VERSION} — ${topic.title}`, '', topic.summary, '', 'Usage:', ...topic.usage.map((value) => `  ${value}`), '', ...topic.details, ''];
  if (topic.examples.length) block.push('Examples:', ...topic.examples.map((value) => `  ${value}`), '');
  if (topic.related.length) block.push(`Related topics: ${topic.related.join(', ')}`);
  block.push(`Detailed documentation: ${topic.url}`, '');
  return block.join('\n');
}

export function renderTopHelp(): string {
  return `BlinkHost CLI ${VERSION}\n\nStart here:\n  blinkhost quickstart [path]   Check local readiness without changing anything\n  blinkhost docs [topic]        Read the version-matched offline reference\n  blinkhost help COMMAND        Show command-specific help\n\nCommands:\n  ${COMMANDS.join('\n  ')}\n\nGlobal options:\n  --json              Write one machine-readable response to stdout\n  --profile NAME      Use a named BlinkHost account profile\n  --quiet             Suppress successful human-readable output\n  --verbose           Include safe diagnostic detail in errors\n  --no-color          Disable terminal colour\n  --non-interactive   Never open a browser or prompt\n  --help              Show command-specific help\n  --version           Show the CLI version\n\nDocumentation: ${DOCUMENTATION_URL}\n`;
}

async function executable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

export async function quickstart(path?: string): Promise<Record<string, unknown>> {
  const root = resolveLocalPath(path);
  const nodeOk = supportedNodeVersion();
  const gitOk = await executable('git', ['--version']);
  const credential = await credentialStoreStatus();
  let directoryOk = true;
  try { await access(root); } catch { directoryOk = false; }
  let project: Record<string, unknown> = { status: 'not_configured', path: root };
  if (directoryOk) {
    try {
      const validation = await validateProject(root);
      project = {
        status: validation.errors.length ? 'invalid' : 'valid', path: root,
        framework: validation.manifest.frontend.framework,
        modules: validation.manifest.modules.length,
        databases: validation.manifest.resources.databases.length,
        errors: validation.errors, warnings: validation.warnings,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      project = { status: code === 'ENOENT' || (error instanceof Error && error.message.includes('No blinkhost.yaml')) ? 'not_configured' : 'unreadable', path: root };
    }
  }
  const nextSteps = project.status === 'valid'
    ? ['blinkhost test .', 'blinkhost auth login', 'blinkhost projects link PROJECT_ID', 'blinkhost dev .']
    : ['blinkhost create my-app --template react --no-install', 'blinkhost init ./existing-app', 'blinkhost docs create', 'blinkhost docs init'];
  return {
    schema: 'blinkhost/cli-quickstart/v1', cli_version: VERSION,
    mode: 'local_read_only', remote_changes: false, billable_resources_created: false,
    checks: [
      { name: 'node', ok: nodeOk, detected: process.versions.node, required: '>=22.12.0', remediation: nodeOk ? null : 'Install Node.js 22.12 or newer.' },
      { name: 'git', ok: gitOk, remediation: gitOk ? null : 'Install Git and ensure it is available on PATH.' },
      { name: 'credential_service', ok: credential.available, provider: credential.provider, required_for: 'interactive account sessions', remediation: credential.remediation },
      { name: 'directory', ok: directoryOk, path: root },
    ],
    project,
    capabilities: {
      frontends: SUPPORTED_FRONTENDS, package_managers: SUPPORTED_MANAGERS, backend_modules: SUPPORTED_MODULES,
      local: ['create', 'init', 'validate', 'manifest', 'doctor', 'test', 'dev', 'docs'],
      remote: ['projects', 'repositories', 'previews', 'builds', 'deployments', 'modules', 'functions', 'databases', 'assets'],
      remote_requirements: 'Authentication, workspace permission, plan capacity, and approval where applicable.',
    },
    next_steps: nextSteps,
    documentation_url: DOCUMENTATION_URL,
  };
}
