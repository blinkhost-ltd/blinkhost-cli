# BlinkHost CLI

The BlinkHost CLI brings project setup, local development, source control, previews, builds, releases, resources, and diagnostics into the terminal while BlinkHost continues to enforce workspace roles, plan limits, protected environments, verified artifacts, and audit history.

## Install

Node.js 22.12 or newer is required.

```bash
npm install --global @blinkhost/cli@2.4.0
blinkhost --version
```

Signed release archives, checksums, the CycloneDX SBOM, and Sigstore verification bundle are available at <https://github.com/blinkhost-ltd/blinkhost-cli/releases>.

## Current release

### 2.4.0 — release intelligence and compatibility guidance

- Added `blinkhost update notes [VERSION]` for terminal-accessible, verified release history.
- Added cached, time-bounded update awareness that stays silent in CI, structured output, and non-interactive sessions.
- CLI token refresh now records the installed client version so project compatibility guidance does not rely on a stale login record.

Run `blinkhost update notes` to read published notes in the terminal. The complete version history and compatibility policy are maintained in [CHANGELOG.md](./CHANGELOG.md) and the [developer release notes](https://app.blinkhost.me/docs/releases).

## Start safely

### In development: Idam staff preview

Create a supported backend starter with `ai starters --project PROJECT_UUID` and
`ai starter-review --project PROJECT_UUID --name api --language LANGUAGE_ID --revision SOURCE_REVISION --request-id REQUEST_UUID`.
Inspect the returned files and retain the review UUID before approving with
`ai starter-approve REVIEW_UUID --project PROJECT_UUID --digest ACTION_DIGEST --confirm REVIEW_UUID`.
This saves new source through normal module limits; it does not build or publish.
No AI credits are used. After an uncertain response, use
`ai starter-status REVIEW_UUID --project PROJECT_UUID` to reconcile the original
save, never another create. Read, preparation and approval require `ai:read`,
`ai:execute` and `ai:approve` respectively. These commands remain unreleased.

Saved WASM modules can be reviewed for a normal, metered build using
`ai build-modules --project PROJECT_UUID`, followed by
`ai build-review --project PROJECT_UUID --module MODULE_UUID --revision SOURCE_REVISION --request-id REQUEST_UUID`.
Retain the request UUID. Review the source in the IDE and the returned digest,
usage policy and expiry. Then explicitly approve with
`ai build-approve REVIEW_UUID --project PROJECT_UUID --digest ACTION_DIGEST --confirm REVIEW_UUID`.
Read/list needs `ai:read`, preparation needs `ai:execute`, and approval needs
`ai:approve`. This uses normal build allowance, configured overages and duration
usage—not AI credits. It does not publish, promote an artifact or commit files.
Unsaved edits are excluded. After a timeout, use
`ai build-status REVIEW_UUID --project PROJECT_UUID` before any further action;
do not create a new review to repeat an uncertain build. See `blinkhost docs ai`.
These commands are staff-only and not yet in the published CLI release.

For an eligible multi-step task, use
`blinkhost ai resume TASK_UUID --confirm TASK_UUID` with `ai:execute` to request
continuation from its saved checkpoint. This keeps the same task, original
credit limit and confirmed usage. Active work and retry delays are preserved;
it does not restart stopped or completed tasks, increase spending, approve
changes or repeat confirmed execution. Project access, revision and guidance
are checked again. After a timeout, inspect `ai status` before taking another
action. This command is not yet in the published CLI release.

Reviewed public sources have a separate disabled-by-default staff gate. Use
`blinkhost ai sources --project PROJECT_UUID` with `ai:read` to inspect the
available excerpts, attribution and capture/review dates. To use them, set
`"mode": "research"` and `"research_source_ids": ["SOURCE_SHA256"]` in the
request JSON (up to four unique IDs). This does not browse or fetch websites.
Source text counts toward the credit estimate. Expired or withdrawn sources
cannot start new work; already dispatched work can finish. Task status/export
retains the excerpts provided, not later versions of the source website. A model
citation is not proof that a conclusion is correct. These commands are not yet
in the published CLI release.

Source-review diffs use `[U+…]` markers for invisible control characters and
annotations for line endings. They are review displays, not patches to copy.
Approvals bind the original source, which these annotations do not modify.
Structured terminal output escapes controls while preserving the exact decoded
JSON values. Ordinary Unicode is retained; this is not a confusable-character
detector or a guarantee that proposed code is safe.

The source branch includes `blinkhost ai` task and reviewed-change commands, with
offline help at `blinkhost docs ai`. They are **not in the published 2.4.0 package**
and require an enabled staff pilot. AI task execution (`ai:execute`) and source
approval (`ai:approve`) are separate, explicitly requested permissions; existing
sessions are unchanged. See the [unreleased changelog](./CHANGELOG.md).

Saving an approved proposal changes workspace source only. Build, test and preview
before publishing. To share source with Azure OpenAI for a task, include optional
`source_paths` in its request JSON (up to eight project-relative paths of saved
workspace files, 16 KiB each / 24 KiB total). No local files are uploaded. Review
selected files for credentials; automated screening is not exhaustive. Omit the
field to share structural metadata only. These commands remain unreleased.

Unknown model usage is never automatically retried or refunded.

To review only part of a proposal, use `blinkhost ai review TASK_UUID --path
src/example.ts` (repeat `--path` for more files). With no paths, all proposed files
are included. Inspect every returned diff before approval. Changing the selection
requires a fresh review; saving finishes the task and omitted files may still be
needed for the application to work. Task exports distinguish the full proposal
from `review.paths`; only a populated review `applied_at` records that selection's
save. This is file selection, not automatic dependency analysis or project copying.

Use `blinkhost ai compatibility --project PROJECT_UUID` for a read-only review of
the saved project's declared dependencies. It requires `ai:read` and the enabled
staff pilot; it is not in the published CLI. Results identify the workspace
revision, manifest paths, declaration sections and inspection limits. Only a fixed
set of npm and Python package names is checked in `package.json` and single-line
`requirements.txt` declarations. Python markers and extras are not evaluated;
includes, pip options, URLs and other manifest formats need manual review.
No findings is **not a compatibility pass**. This command uploads no local
files, makes no model calls, reserves no credits and does not install, build, test,
adapt or deploy code. Customer backend execution remains WASM-only. Review project
metadata before sharing command output, and rerun after workspace changes.

You can save optional project guidance for your own future tasks using the
unreleased `ai memory-show`, `memory-save` and `memory-clear` commands. First run
`blinkhost ai memory-show --project PROJECT_UUID` and inspect the saved version.
Then use `blinkhost ai memory-save --project PROJECT_UUID --file @guidance.txt
--expected-version VERSION --confirm PROJECT_UUID` to upload a regular UTF-8 file
of at most 4 KiB. Saving authorizes sending this guidance with future model tasks;
it does not change permissions, runtime support or billing. Keep credentials out.
`memory-show` prints private text: take care with logs and shared terminals.

To clear it, run `blinkhost ai memory-clear --project PROJECT_UUID
--expected-version VERSION --confirm PROJECT_UUID`. Editing or clearing prevents
queued tasks and later workflow steps from using an older version. Work already
sent may finish. Existing task copies and backups are not erased. After a timeout
or conflict, reload and compare with `memory-show` before another write; the CLI
never retries it automatically. Reading requires `ai:read`; saving and clearing
require `ai:execute`. CI workload identities cannot use the personal Idam preview,
including indirectly through task creation or history, regardless of token scopes.

Connected investigation-and-review sequences are also in development, behind a
separate disabled staff gate. Inspect `ai status TASK_UUID` first. Then
`ai workflow-plan TASK_UUID --maximum-units TOTAL_LIMIT --confirm TASK_UUID`
saves a draft with two follow-ups of 80 credits each. `TOTAL_LIMIT` must
cover the original task's approved limit plus 160 credits, up to 2,000 total.
Saving does not approve follow-ups; the original task continues independently.
`workflow-start` remains a draft-only compatibility alias. Use
`ai workflow-status WORKFLOW_UUID` to inspect the saved plan and version history.
To change a draft, use `ai workflow-revise WORKFLOW_UUID --request @plan.json
--expected-revision VERSION --digest PLAN_DIGEST --confirm WORKFLOW_UUID`.
The regular UTF-8 JSON file (16 KiB maximum) contains exactly `steps`,
`maximum_units` and `maximum_context_units`; see `blinkhost docs ai` for the schema.
Then approve the version you inspected with `ai workflow-approve WORKFLOW_UUID
--expected-revision VERSION --digest PLAN_DIGEST --confirm WORKFLOW_UUID`.
Changed drafts require fresh review; approved or stopped plans cannot be edited.
Reading requires `ai:read`, preparing or revising a plan requires `ai:execute`,
and approving it requires the separate `ai:approve` permission. Approval permission
does not grant access to another user's plan or bypass current project access.
These operations grant no funding and reserve no additional credits. Each later
step checks available balance and current project access. Use
`ai workflow-cancel WORKFLOW_UUID --confirm WORKFLOW_UUID` to stop later steps.
After a timeout, task status exposes `analysis_workflow.id`; inspect it before
making another write. Never automatically retry approval or reuse stale versions.
These are drafts, not executed tests or deployments.
Follow-ups retain the original request and previous draft under their own task
retention periods. Removing one task does not remove copies in another.

`blinkhost ai export TASK_UUID --json` prints a versioned private task record.
Add `--include-source` only when you want proposed source-file copies included.
Requests and narrative may still contain private information: review before
sharing. This is not a project backup or deployment certificate. Removed content
is not reconstructed; long histories are marked partial, and existing downloads
are outside task-history retention. See `blinkhost docs ai` for limits.

To undo an Idam source save in the staff preview, run
`blinkhost ai rollback-review TASK_UUID --json`, inspect its file restorations and
removals, then run `blinkhost ai rollback-approve TASK_UUID --digest UNDO_ACTION_DIGEST --confirm TASK_UUID`.
This is a separate, expiring approval, not the original source-save digest.
Preparing requires `ai:execute`; confirming requires `ai:approve`. Later edits to
affected files block undo. Other files and folders are preserved. Removed task
content cannot be recovered. Undo does not reverse deployments, charges or Git
commits. Check the task after a timeout; these commands do not automatically retry.

### Local readiness

```bash
blinkhost quickstart
blinkhost docs
blinkhost docs automation
blinkhost help create
```

`quickstart` is local, read-only, and makes no network requests. It checks Node.js, Git, the operating-system credential service, the selected directory, and any existing BlinkHost manifest. It never signs in, uploads source, creates a cloud resource, or incurs usage. The bundled `docs` reference is offline and matches the installed CLI version; use the linked web documentation for longer guides.

## Connect an account

```bash
blinkhost auth login
blinkhost auth status
blinkhost auth sessions
```

The CLI opens a BlinkHost approval page in your browser. It never accepts your BlinkHost password. Access tokens last 15 minutes; rotating refresh credentials are stored only in the operating-system credential service. Use named profiles for separate accounts:

```bash
blinkhost auth login --profile work
blinkhost profile use work
```

Revoke a device with `blinkhost auth revoke SESSION_ID` or disconnect all CLI sessions for the active profile with `blinkhost auth logout`.

Interactive credential storage uses macOS Keychain, Windows Password Vault, or Linux Secret Service (`secret-tool` with an available, unlocked session keyring). The CLI intentionally does not fall back to a plaintext refresh-token file. Headless systems should use a registered GitHub OIDC workload or a short-lived runtime access token.

Before opening browser authorization, the CLI checks that the credential tooling can run. This does not prove that your keyring is unlocked; on Linux, start an unlocked Secret Service session first. Missing tooling is reported before a device authorization is requested.

## Create or adopt a project

```bash
blinkhost create study-circle --template astro --module search:typescript --module reminders:python --database PRIMARY_DB
cd study-circle
blinkhost validate
blinkhost projects link PROJECT_ID
blinkhost dev
```

Supported frontends are Astro, HTML, React, Solid, Svelte, and Vue. Backend modules may use Rust, Go, Python, JavaScript, or TypeScript. Python, JavaScript, and TypeScript Functions are beta capabilities with bounded runtime and dependency policies. `blinkhost init` detects supported frontend metadata and reviewed `_server_islands/*/blinkhost.toml` module declarations in an existing repository, then creates `blinkhost.yaml` for review. Preview the exact result without writing anything first:

```bash
blinkhost init apps/storefront --dry-run --json
```

`init` writes only `blinkhost.yaml`, refuses an existing manifest unless `--force` is explicitly supplied, and never rewrites application source. It proposes only safe module declarations already present under `_server_islands`; review them and add other intended modules explicitly. One manifest describes one deployable application. In a monorepo, select the application directory, or place the manifest at a build-context root that contains the app and its shared workspace packages; use separate BlinkHost projects for independently deployable apps.

Creation is atomic and refuses to replace an existing path. Dependency lifecycle scripts are disabled. Validation rejects unknown manifest fields, duplicate YAML keys, aliases, traversal, unsafe symbolic links, invalid cross-platform paths, duplicate module names, and missing declared inputs.

When using `--no-install`, enter the generated directory, run the selected package manager's install command, then run `blinkhost test .`. For example:

```bash
blinkhost create study-circle --template astro --no-install
cd study-circle
npm install
blinkhost test .
```

## Remote workflows

### Download project source

```bash
blinkhost projects export PROJECT_UUID --output ./project-source.zip --json
```

This downloads source and portable configuration through BlinkHost's existing
export service. It requires `projects:read` and an owner, admin or developer role;
connecting GitHub is optional. Choose a new `.zip` filename in an existing
directory without symbolic links. Downloads are limited to 32 MiB and 30 seconds.
The CLI does not follow redirects, replace existing files, extract the ZIP or run
its contents. It returns a SHA-256 checksum and saves with private permissions
where POSIX permissions apply.

The archive is **not a database backup or a running deployment**. Database rows,
runtime secrets, deployed artifacts and complete Git history are not included.
Source is screened for possible credentials, but review it before sharing.
Configure resources and secrets separately, and check compatibility before running
the exported application elsewhere. `ai export` instead exports a task record.

Resource commands use the same pattern:

```bash
blinkhost projects list
blinkhost projects get PROJECT_ID
blinkhost previews list --query project=PROJECT_ID
blinkhost builds list --query project=PROJECT_ID
blinkhost deployments get DEPLOYMENT_ID
blinkhost modules list --query site_id=PROJECT_ID
blinkhost databases list --query project=PROJECT_ID
blinkhost organizations get ORGANIZATION_ID
```

Create and update operations accept a JSON object or `@path` to a JSON file:

```bash
blinkhost projects create --data @project.json
blinkhost deployments action DEPLOYMENT_ID rollback --data @rollback.json
```

Destructive operations require the exact resource ID twice:

```bash
blinkhost previews delete PREVIEW_ID --confirm PREVIEW_ID
```

Connected repository, release, approval, agency handoff, enterprise policy, and template APIs are available through `repositories`, `connections`, `builds`, `approvals`, `handoffs`, `policies`, and `templates`. Advanced customer API operations can use `blinkhost api METHOD /api/path/`; internal, staff, and authentication routes are blocked.

## Function triggers and runs

Manage beta event, schedule, and background triggers without using raw API routes:

```bash
blinkhost functions status [PROJECT_ID]
blinkhost functions triggers list MODULE_ID
blinkhost functions triggers create MODULE_ID --data @trigger.json
blinkhost functions invoke run MODULE_ID TRIGGER_ID --data @payload.json --idempotency-key order-1042
blinkhost functions invocations list MODULE_ID
blinkhost functions invocations get MODULE_ID INVOCATION_ID
blinkhost functions invocations result MODULE_ID INVOCATION_ID
blinkhost functions invocations cancel MODULE_ID INVOCATION_ID
blinkhost functions invocations retry MODULE_ID INVOCATION_ID --idempotency-key retry-order-1042
```

`functions status` reports the effective language and trigger capabilities for a project; omit the project ID inside a linked directory. Payloads must be JSON objects no larger than 256 KiB. Use a stable idempotency key when repeating the same logical request. Runs remain subject to workspace roles, rollout availability, verified artifacts, runtime policy, and plan limits.

## Secrets and resources

Secret values never appear in command arguments or `blinkhost.yaml`. Pipe them over standard input:

```bash
printf '%s' "$MY_SECRET" | blinkhost secrets set API_TOKEN --project PROJECT_ID --environment production
printf '%s' "$NEW_VALUE" | blinkhost secrets rotate SECRET_ID
```

Database, binding, module, and asset operations remain subject to workspace permissions and plan storage limits. Upload reservations and final integrity checks use the project asset API.

## Observability and support

```bash
blinkhost logs --project PROJECT_ID --since 1h --limit 100
blinkhost metrics --project PROJECT_ID --since 24h
blinkhost analytics --project PROJECT_ID
blinkhost doctor
blinkhost support bundle
```

Support bundles are local, redacted JSON files with mode `0600`. They exclude tokens, secret values, source code, filenames, and repository URLs.

## CI and automation

All commands support `--json`. In JSON mode, stdout contains exactly one response object on success or failure; subprocess and human diagnostics use stderr. Register one exact GitHub branch, tag, or protected environment as a workload identity, then grant the workflow `id-token: write`. The CLI exchanges GitHub's signed OIDC assertion for a ten-minute BlinkHost token automatically; no BlinkHost secret is stored in GitHub.

```bash
blinkhost workloads create --data @workload.json
```

`workload.json` identifies the workspace, exact GitHub OIDC subject, and narrow permissions. For non-GitHub systems, an externally issued short-lived credential may be provided as `BLINKHOST_ACCESS_TOKEN`; do not persist it in the repository or pass it as an argument.

```bash
blinkhost ci check --json
blinkhost validate --json
blinkhost builds create --data @build.json --json
```

Stable exit codes distinguish usage, validation, filesystem, authentication, network, remote-service, and conflict failures. Mutations include request identifiers and idempotency keys.

## Shell completion, updates, and plugins

```bash
blinkhost completion bash   # also zsh, fish, or powershell
blinkhost update check
blinkhost update notes
blinkhost update notes 2.4.0
blinkhost plugins add /absolute/path/to/plugin --name example
blinkhost plugins verify example
blinkhost plugins run example -- arguments
```

Update checks never install software. At most once every 48 hours, an interactive terminal may perform a cached, time-bounded check after a successful command and print one upgrade line. Checks are suppressed in CI, JSON output, and non-interactive sessions; set `BLINKHOST_NO_UPDATE_NOTIFIER=1` to suppress them explicitly. Plugins require explicit local approval, are pinned to their executable SHA-256 digest, stop when the executable changes, and receive neither BlinkHost credentials nor the parent environment. A plugin is still third-party code running with your operating-system account; review it before adding it.

Pin or roll back explicitly with `npm install --global @blinkhost/cli@VERSION`. Tagged packages are published from the `blinkhost-ltd/blinkhost-cli` release workflow through npm Trusted Publishing with provenance. To verify a downloaded GitHub release, first run `sha256sum --check SHA256SUMS`, then verify its Sigstore bundle:

```bash
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/blinkhost-ltd/blinkhost-cli/.github/workflows/release.yml@refs/tags/v2.4.0" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

The supported runtime is Node.js 22.12 or newer on Linux, macOS, and Windows, including x64 and arm64 environments where that Node release is available. Bash, Zsh, Fish, and PowerShell completion are generated by the CLI. For an offline installation, verify the package archive, checksum file, and Sigstore bundle on a connected machine, transfer them through an approved channel, then run `npm install --global ./blinkhost-cli-VERSION.tgz --offline`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid command or option |
| 3 | Project or input validation failed |
| 4 | Filesystem or local executable failure |
| 5 | Unexpected internal failure |
| 6 | Authentication or authorization failure |
| 7 | Network or timeout failure |
| 8 | Remote service failure |
| 9 | State conflict or approval required |

Run `blinkhost --help` for the complete command index.
