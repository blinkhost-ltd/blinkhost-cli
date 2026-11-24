# BlinkHost CLI

The BlinkHost CLI brings project setup, local development, source control, previews, builds, releases, resources, and diagnostics into the terminal while BlinkHost continues to enforce workspace roles, plan limits, protected environments, verified artifacts, and audit history.

## Install

Node.js 22.12 or newer is required.

```bash
npm install --global @blinkhost/cli@2.8.1
blinkhost --version
```

Signed release archives, checksums, the CycloneDX SBOM, and Sigstore verification bundle are available at <https://github.com/blinkhost-ltd/blinkhost-cli/releases>.

## Build a CMS or an agent workflow

Start a customizable newsroom with separate draft and published views, or build a support agent that routes tickets to a queue. Both kits run in your application with your own data, permissions and provider accounts.

Use Node.js 22.18 or newer for the kits. The release includes verified installation instructions, starter commands and an optional SDK adapter. [CMS and agent workflow kits v0.1.1](https://github.com/blinkhost-ltd/blinkhost-cli/releases/tag/app-helpers-v0.1.1)

## 2.7.0 — UI and design references

Search reviewed design guidance and code in the context of an accessible project:

```bash
blinkhost design list --project PROJECT_UUID --json
blinkhost design search "accessible agency pricing page" --project PROJECT_UUID --framework react --limit 5 --json
blinkhost design show REFERENCE_ID --project PROJECT_UUID --revision REVISION_HASH --json
blinkhost design notices REFERENCE_ID --project PROJECT_UUID --revision REVISION_HASH --json
```

Use the reference ID and immutable revision returned by search. For visual matching,
add `--attachment UPLOAD_UUID` and optionally `--image-index 0` to a search; the upload
must already be ready and accessible through that project. Responses report which
retrieval methods were available. These commands require an enabled control plane,
authorized Idam read access and workspace membership. They do not install packages
or modify project source. When adapting source code, preserve the returned notice
files and provenance in the project; no public badge is required. Treat reference
content as data, not instructions to execute.

## 2.6.0 — SEO and AEO commands

Run `blinkhost seo local ./out --gate --json` to check local HTML metadata,
or `blinkhost seo audit PROJECT_UUID --pages 10 --json` for a hosted audit.
Use `blinkhost seo findings PROJECT_UUID AUDIT_UUID --json` until the audit is
terminal, then inspect its coverage and gate. `blinkhost seo --help` lists
verification, imports, reports and selected-model Idam remediation commands.
Hosted access requires an enabled server and an existing subscription allowance.
Upgrade from 2.5.2 to use these commands.

The same release adds these workflows:

| Workflow | Commands |
| --- | --- |
| Public deployment documentation | `content-status`, `content-index`, `content-search`, `content-result`, `content-delete` |
| Selected-model answer experiments | `sample`, `samples`, `sample-result`, `sample-delete` |
| Prepaid Azure public research | `research-status`, `research`, `research-result`, `research-cancel` |
| Owner search reports | `import-native PROJECT_UUID FORMAT EXPORT_FILE PROVENANCE.json` |

Search, sample and research submissions read a JSON request file. Give each new
request a UUID in `client_request_id`, retain that file when recovering a lost
response, and poll the returned ID. For example, `content-search` accepts:

```json
{"client_request_id":"b3af715d-7276-42b7-908c-ea8c59ef019e","query":"How do I deploy?","count":5,"locale":"en"}
```

`sample` accepts `model`, `maximum_units`, `question`, one to five public `paths`
and `required_facts`, alongside the request UUID. The chosen permitted model uses
ordinary Idam and its AI wallet. Results show documentation support and missing
facts for that experiment; they do not establish visibility in external AI apps.

`research` requires all six fields:

```json
{"client_request_id":"8bfb3b6c-3b0a-41fd-80d7-af6879fb4036","model":"YOUR_PERMITTED_MODEL","maximum_units":100,"query":"Public documentation about sitemap indexes","max_reads":1,"public_query_consent":true}
```

Use `research-status` to inspect available prepaid USD and the per-read hold.
Ordinary Idam model work uses the AI wallet; Azure public search and its grounding
model use the separate research allowance funded by verified checkout. Cancelling
prevents future reads; already sent reads still settle their actual cost.

Native imports accept `google-search-console-csv`, `google-search-console-zip`
and `bing-webmaster-csv`. Supply the authorized property, reporting period and
other provenance in the separate JSON file. The server validates report ownership
and supported dimensions before retaining it.

## Earlier releases

### 2.5.2 — deployment request recovery

Activate, promote, retry and rollback require a saved `--idempotency-key`.
Update scripts to supply a key before upgrading. These commands require a
control plane with deployment publication support; recovery reads the original
request after a timeout without submitting another deployment. Keep the same
account, profile and key while recovering. Workspace permissions and approvals
still apply.

### 2.5.1 — saved-session concurrency

Commands sharing a saved profile serialize credential refresh and sign-out so
concurrent processes do not reuse a rotated credential. Temporary refresh
failures preserve the saved credential; rejected sessions still require a fresh
sign-in. Explicit environment credentials remain the caller's responsibility.
If a command reports `credential_busy`, let the other command finish. After a
crash, confirm that no command for that profile is running before removing the
reported lock file. The file contains process metadata, never credentials.

### 2.5.0 — Idam limited preview

- Added Idam task, source-review, starter, build, export and connected-review commands.
- Connected-review plans default to GPT-6 Luna and support GPT-6 Sol and GPT-5.6 Terra; older GPT-5.6 plans remain readable.
- Improved scoped sign-in and operating-system credential handling on Linux, macOS and Windows.

Idam remains a limited preview. Access depends on the server rollout, current
project permissions and available credits. Installing this CLI does not enable
Idam or change a subscription. No project migration is required from 2.4.0.

Run `blinkhost update notes` to read published notes in the terminal. The complete version history and compatibility policy are maintained in [CHANGELOG.md](./CHANGELOG.md) and the [developer release notes](https://app.blinkhost.me/docs/releases).

## Start safely

### Idam limited preview

Request a review of selected code with
`ai peer-options TASK_UUID --project PROJECT_UUID`, then
`ai peer-invite TASK_UUID --project PROJECT_UUID --reviewer USER_ID --digest ACTION_DIGEST --confirm TASK_UUID`.
Prepare and inspect `ai review` first. Only the selected before-and-after code
is shared with the named owner or administrator; conversations and other
proposed files remain private. The reviewer uses `ai peer-inbox --project PROJECT_UUID`,
`ai peer-review PEER_UUID --project PROJECT_UUID`, then
`ai peer-approve PEER_UUID --project PROJECT_UUID --digest REVIEW_DIGEST --confirm PEER_UUID`
or `peer-decline` with the same options. Read commands need `ai:read`; sharing
and decisions need `ai:approve`. Decisions never save, build or publish.
The requester saves separately after approval, or explicitly withdraws with
`ai peer-withdraw TASK_UUID --project PROJECT_UUID --peer PEER_UUID --confirm TASK_UUID`.
Sharing is optional, but your workspace may require independent approval before
Idam source saves. Withdrawal ends sharing and preserves history; it does not
bypass workspace-required review.
Reviews expire after at most 15 minutes and changes to source or permissions
require fresh review. Inspect current status after a timeout; do not retry
automatically. This policy covers Idam source saves only, not starter creation,
builds or deployments; those retain their separate permissions and approvals.
These commands require current Idam access. See `blinkhost docs ai`.

Create a supported backend starter with `ai starters --project PROJECT_UUID` and
`ai starter-review --project PROJECT_UUID --name api --language LANGUAGE_ID --revision SOURCE_REVISION --request-id REQUEST_UUID`.
Inspect the returned files and retain the review UUID before approving with
`ai starter-approve REVIEW_UUID --project PROJECT_UUID --digest ACTION_DIGEST --confirm REVIEW_UUID`.
This saves new source through normal module limits; it does not build or publish.
No AI credits are used. After an uncertain response, use
`ai starter-status REVIEW_UUID --project PROJECT_UUID` to reconcile the original
save, never another create. Read, preparation and approval require `ai:read`,
`ai:execute` and `ai:approve` respectively.

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
when a confirmed portable-size rejection includes validated measurements, this
command shows the observed lower bound, the admitted maximum in bytes, and
guidance to reduce bundled code or dependencies. Checking status never retries
the build. Older build receipts retain their existing status behavior; malformed
measurements do not become size or plan-upgrade advice.
do not create a new review to repeat an uncertain build. See `blinkhost docs ai`.
These commands require current Idam access and an available module compiler.

For an eligible multi-step task, use
`blinkhost ai resume TASK_UUID --confirm TASK_UUID` with `ai:execute` to request
continuation from its saved checkpoint. This keeps the same task, original
credit limit and confirmed usage. Active work and retry delays are preserved;
it does not restart stopped or completed tasks, increase spending, approve
changes or repeat confirmed execution. Project access, revision and guidance
are checked again. After a timeout, inspect `ai status` before taking another
action.

Reviewed public sources have a separate feature gate that is off by default. Use
`blinkhost ai sources --project PROJECT_UUID` with `ai:read` to inspect the
available excerpts, attribution and capture/review dates. To use them, set
`"mode": "research"` and `"research_source_ids": ["SOURCE_SHA256"]` in the
request JSON (up to four unique IDs). This does not browse or fetch websites.
Source text counts toward the credit estimate. Expired or withdrawn sources
cannot start new work; already dispatched work can finish. Task status/export
retains the excerpts provided, not later versions of the source website. A model
citation is not proof that a conclusion is correct.

Source-review diffs use `[U+…]` markers for invisible control characters and
annotations for line endings. They are review displays, not patches to copy.
Approvals bind the original source, which these annotations do not modify.
Structured terminal output escapes controls while preserving the exact decoded
JSON values. Ordinary Unicode is retained; this is not a confusable-character
detector or a guarantee that proposed code is safe.

Version 2.5.0 includes `blinkhost ai` task and reviewed-change commands, with
offline help at `blinkhost docs ai`. They require an enabled Idam preview.
AI task execution (`ai:execute`) and source
approval (`ai:approve`) are separate, explicitly requested permissions; existing
sessions do not gain these permissions automatically. See the [changelog](./CHANGELOG.md).

Saving an approved proposal changes workspace source only. Build, test and preview
before publishing. To share source with Azure OpenAI for a task, include optional
`source_paths` in its request JSON (up to eight project-relative paths of saved
workspace files, 16 KiB each / 24 KiB total). No local files are uploaded. Review
selected files for credentials; automated screening is not exhaustive. Omit the
field to share structural metadata only.

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
Idam preview. Results identify the workspace
revision, manifest paths, declaration sections and inspection limits. Only a fixed
set of npm and Python package names is checked in `package.json` and single-line
`requirements.txt` and static `pyproject.toml` declarations. Runtime, optional and
build-system requirements keep distinct labels; build-only use is not runtime
use. Python markers and extras are not evaluated. Dynamic dependencies, tool
overrides, includes, pip options, URLs and other manifest formats need manual
review. No lockfile or transitive dependency graph is resolved.
No findings is **not a compatibility pass**. This command uploads no local
files, makes no model calls, reserves no credits and does not install, build, test,
adapt or deploy code. Customer backend execution remains WASM-only. Review project
metadata before sharing command output, and rerun after workspace changes.

You can save optional project guidance for your own future tasks using the
`ai memory-show`, `memory-save` and `memory-clear` commands. First run
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

Connected investigation-and-review sequences require a separate feature gate.
Inspect `ai status TASK_UUID` first. Then
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

To undo an Idam source save in the limited preview, run
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

## SEO and AEO request retries

Hosted audits, verification and Idam remediation accept `--request-id REQUEST_UUID`:

```bash
blinkhost seo audit PROJECT_UUID --pages 100 --request-id REQUEST_UUID
blinkhost seo verify PROJECT_UUID AUDIT_UUID --request-id REQUEST_UUID
blinkhost seo remediate PROJECT_UUID AUDIT_UUID --model MODEL --max-units 100 --findings FINDING_KEY --request-id REQUEST_UUID
```

Choose a UUID for each new task and keep it with the command. After a timeout or
lost response, retry the same command with the same UUID and unchanged inputs.
This lets the server reuse the original task and wallet hold. Changing the model,
wallet limit, findings or audit options requires a fresh UUID for a new task.
If omitted, the CLI generates an ID and includes it as `SEO request ID` in a
submission error, so you can supply it with `--request-id` when retrying.

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

If your CLI session is rejected after signing out of all devices, an account
security change or a BlinkHost security update, run `blinkhost auth login` again
with the same `--profile` and any explicit `--scope` options you need. Sign in to
the correct account in your browser and review the new request before approving.
Reopening an old approval link does not reconnect the CLI. Reauthentication does
not change your project files, deployments or billing plan. If the new sign-in is
blocked, check email verification and any required legal acceptance in the
dashboard; do not copy credentials from another device to work around it.

Interactive credential storage uses macOS Keychain, Windows Password Vault, or Linux Secret Service (`secret-tool` with an available, unlocked session keyring). The CLI intentionally does not fall back to a plaintext refresh-token file. Headless systems should use a registered GitHub OIDC workload or a short-lived runtime access token.

Before opening browser authorization, the CLI checks that the credential tooling can run. This does not prove that your keyring is unlocked; on Linux, start an unlocked Secret Service session first. Missing tooling is reported before a device authorization is requested.

Credential-tool checks stop after five seconds on macOS and Linux, or 15 seconds
on Windows to allow PowerShell to start. Credential reads and writes stop after
30 seconds. These checks do not retry. Keyring errors use safe messages without displaying helper
output. On Linux, an unavailable session keyring is reported as a credential-service
failure rather than a missing sign-in. Unlock or restart your Secret Service session.
If browser approval succeeded but saving the session failed or timed out, review
your CLI sessions in BlinkHost settings before starting another sign-in. The CLI
does not automatically retry credential writes or fall back to plaintext storage.

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

On x86-64 Ubuntu 24.04 with OpenSSL 3, the optional local stack can run libSQL,
your compiled WASM module and a static frontend together. Install the BlinkHost
local runtime and its matching WasmEdge library. The archive's SHA-256 digest is
`852962e6c1bd4a66bb1dff66e16818cd2980a5e3dcb41316f6568db174b4134f`.
Use the signed checksum list and verification command in the packaged guide.
[BlinkHost local runtime](https://github.com/blinkhost-ltd/blinkhost-cli/releases/tag/local-runtime-v2.8.0) · [CLI v2.8.0 signed checksums](https://github.com/blinkhost-ltd/blinkhost-cli/releases/tag/v2.8.0)
The ordinary frontend development command and native project tests can run
independently of those binaries.

```bash
mkdir -p local-data
blinkhost dev . --local-config blinkhost.local.json --state-dir local-data/run-001 --json
```

Both options are required. Application validation happens first; configuration
paths resolve against the application and input paths against the configuration
file. Use the packaged `dist/local-development/blinkhost.local.example.json`
as your template. Supply verified SHA-256 digests for your separate local runtime,
WasmEdge 0.18.1 library, libSQL 0.24.32 executable and compiled portable artifact.
For a first module, the packaged local development guide includes a complete Rust
HTTP handler and the stock Rust command to compile it. [Build your first portable backend module](./dist/local-development/README.md#build-your-first-portable-backend-module)
The CLI archive includes the orchestration code; it does not download toolchains.
The state directory must be new, have an existing parent and sit outside the
served frontend. Data and bounded private evidence remain there after shutdown.

Local stack mode chooses loopback ports, so omit `--host` and `--port`. It uses
the Free local profile: 128 MiB guest memory, a 20,000,000-byte portable
allowance and a request budget of at most 30 seconds. Explicit setup SQL applies
your schema/fixtures to the local database. Native DEFAULT operations require
`database.native` with explicit `read`, `write` and `transaction` booleans, plus a
local runtime built with `--features customer-local-database`. At least one grant
must be true; omission keeps native operations disabled. The readiness record
provides the generated database/generation scope for SDK calls. The packaged
local-development README documents receipts, rollback and permission behavior.
The frontend serves built/static files. `--watch-artifact` can reload separately
compiled artifacts; coverage uses separate tooling.

To compile source once before starting the local stack, also pass
`--local-build-config blinkhost.build.json`. This optional Linux workflow runs
your pinned compiler wrapper against an explicit source-file snapshot, checks
that its inputs stayed unchanged, and gives the resulting portable artifact to
the same WasmEdge/libSQL stack. Its new state directory contains `build-001/`,
`compiled-stack.json` and `stack/`. The original configuration stays intact.
See the packaged local-development README for the build schema, limits and
compiler environment. Prepare the matching SDK/compiler/dependencies first;
this option does not install dependencies. Add `--watch-source` to rebuild when
the declared source files change. Rebuilds run serially and retain private build
receipts; compiler or runtime admission failures keep the working module.
Watching stops after 32 rebuilds or 64 normal events, with an explicit final
event. Changes to build or stack configuration require a fresh run. Source
watching cannot be combined with `--watch-artifact`; AOT and coverage use
separate tooling.

Optional `providers` in the local configuration start customer-owned loopback
fixtures for email, payments or AI. Define exact method/path routes and ordered
responses, including failures, delays and SSE chunks. Read their URLs from
`provider_fixtures` in the readiness record and supply them to your application's
native integration tests or provider adapters. They use no real provider or
internal BlinkHost service. Declaring fixtures leaves guest outbound permissions
disabled. Guest access requires the runtime feature `customer-local-providers`
and an explicit `provider_permissions` grant naming the declared fixtures and
module. The owner pins that grant to the artifact digest and exact loopback
listeners; see the packaged README. Shutdown keeps
private `provider-fixtures.json` with bounded counters and body digests, excluding
request payloads and headers. See the packaged
`dist/local-development/README.md` for configuration examples and limits.

JSON mode emits a readiness record with the actual service origins, followed by
a final result on shutdown. Ctrl-C/SIGTERM after readiness stop owned processes
and exit zero; interrupted startup and unexpected process failures exit nonzero.
Readiness delivery is bounded to three seconds and final delivery to one second.
A broken or stalled output write stops owned processes; incomplete output fails
the command. An idle pipe disconnect may be detected only at the next write.
Local development performs no BlinkHost account or update API requests.

The locally qualified Linux profile uses WasmEdge 0.18.1, libSQL 0.24.32 and
the configured 128 MiB Free resource contract. Representative compiled
JavaScript, TypeScript, Python, Go and Rust modules have passed HTTP/database
and Chromium frontend checks, migrations/seeds/reset, isolated native
transactions, explicit provider grants, cancellation, and source build/watch
through the installed CLI. Shutdown checks cover only processes started by
that local run; retained databases and evidence stay in its state directory.
These results cover portable WASM and deterministic local providers. Toolchain
installation, AOT preparation, live provider behavior, production routing and
performance/capacity qualification have separate workflows.

`init` writes only `blinkhost.yaml`, refuses an existing manifest unless `--force` is explicitly supplied, and never rewrites application source. It proposes only safe module declarations already present under `_server_islands`; review them and add other intended modules explicitly. One manifest describes one deployable application. In a monorepo, select the application directory, or place the manifest at a build-context root that contains the app and its shared workspace packages; use separate BlinkHost projects for independently deployable apps.

Creation is atomic and refuses to replace an existing path. Dependency lifecycle scripts are disabled. Validation rejects unknown manifest fields, duplicate YAML keys, aliases, traversal, unsafe symbolic links, invalid cross-platform paths, duplicate module names, and missing declared inputs.

When using `--no-install`, enter the generated directory, run the selected package manager's install command, then run `blinkhost test .`. For example:

```bash
blinkhost create study-circle --template astro --no-install
cd study-circle
npm install
blinkhost test .
```

`blinkhost test` reports a frontend test command, a `build_only` check when no
frontend test script exists, or `validation_only` for static HTML. A successful
test command provides `command_exit_only` evidence; test counts and native/WASM
coverage are not collected. By default, declared backend modules are listed as `not_run`.
Use `--json` to read the versioned result and avoid treating a successful build
or structure check as test evidence.

Add an optional `blinkhost.tests.json` at the project root to select commands:

New projects can generate executable backend unit-test examples with `--tests`:

```bash
blinkhost create my-app --template html --module api:typescript --module jobs:python --tests --no-install
cd my-app
blinkhost test . --json
```

This opt-in creates `blinkhost.tests.json`, `TESTING.md` and two native tests per
module. JavaScript/TypeScript tests call the actual handler; Python/Go/Rust tests
share application logic with the guest entrypoint. Rust uses a separate native
crate and Go selects a pure application package, avoiding WASI SDK host imports
in the native tests. JavaScript/TypeScript, Python and Rust tests live outside the
guest bundle under `tests/native/`. The Python runner disables bytecode writes
to keep unsupported cache files out of guest sources. TypeScript uses Node's experimental type stripping and does
not typecheck. Other frontend templates add a separate build check, requiring
frontend dependency installation first. HTML selects no frontend tests.
These native tests do not certify host calls, compiled WASM, libSQL or browsers.
`--tests` requires modules and permits at most 32 checks including a frontend build.

Use `runner: node`, `python-unittest`, `go` or `rust` instead of `command` for
bundled native adapters. The CLI resolves its installed files, so the application
does not need a dependency on `@blinkhost/cli` or adapter filesystem paths.
Installed runners require `kind: test` and `profile: native`; structured results
are enabled automatically. Install the selected language tools on PATH. The
locally qualified Linux versions are Node 22.23.3, Python 3.12.3, Go 1.27.3 and
Rust/Cargo 1.98.0. Customer-owned custom commands remain available separately.

```json
{
  "schema": "blinkhost.local-test-config/v1",
  "checks": [
    { "id": "frontend-unit", "target": "frontend", "command": "npm", "args": ["run", "test"], "kind": "test", "profile": "browser" },
    { "id": "api-unit", "target": "module:api", "command": "cargo", "args": ["test", "--locked"], "kind": "test", "profile": "native" },
    { "id": "worker-unit", "target": "module:worker", "command": "python", "args": ["-m", "unittest", "discover", "-s", "tests"], "kind": "test", "profile": "native" }
  ]
}
```

Adapt the example to your declared modules and installed test tools. Configuration
replaces the default frontend command; unselected modules remain visibly untested.
Targets are `frontend`, `project`, or `module:NAME`. The working directory defaults
to the frontend dependency root, project root, or declared module root; optional
`cwd` selects another regular directory inside the project. Commands run sequentially
as executable plus literal arguments, without an implicit shell. Use `kind: build`
for build checks and `kind: integration` for integrations. `profile` records your
declared `native`, `wasm`, or `browser` intent; it does not certify the actual
runtime. Counts remain unknown without structured runner results.
All rows validate before any command starts. Limits are 64 KiB of configuration,
32 checks, 64 arguments/check and 32 KiB of combined argument bytes/check.
Command arguments are not echoed into result receipts.

For structured results, add `"results": { "format": "blinkhost/v1" }` to a test
or integration check. The CLI creates a fresh temporary result directory for each
command and supplies `BLINKHOST_TEST_RESULT_PATH`, `BLINKHOST_TEST_RUN_ID`,
`BLINKHOST_TEST_CHECK_ID` and `BLINKHOST_TEST_PROFILE`. Your runner adapter writes
one UTF-8 JSON file to that path before exiting:

```json
{
  "schema": "blinkhost.local-test-results/v1",
  "run_id": "value of BLINKHOST_TEST_RUN_ID",
  "check_id": "value of BLINKHOST_TEST_CHECK_ID",
  "profile": "value of BLINKHOST_TEST_PROFILE",
  "runner": "your-runner/version",
  "tests": [
    { "id": "auth-denies-expired-token", "name": "Expired tokens are denied", "status": "passed", "duration_ms": 12 }
  ],
  "coverage": { "status": "collected", "metrics": { "lines": { "covered": 80, "total": 100 } } }
}
```

An adapter must translate actual runner results; do not infer passing tests from
a successful build or command. Test IDs are unique within each check. Status is
`passed`, `failed`, `skipped` or `unsupported`; optional bounded `message` and
`stack` fields carry diagnostics. Empty tests report `no_tests`, and skipped or
unsupported tests count as zero executions. Durations are integer milliseconds.
Missing, invalid, replayed or mismatched required reports fail the command.
Reported failed tests fail the check even if the process exits zero; nonzero
process exits always remain failures. Following checks remain explicitly unrun.

Coverage is optional (`not_collected`), `unavailable`, or `collected` with at
least one of `lines`, `branches`, and `functions`, each containing integer
`covered` and `total` counts. Covered cannot exceed total. Collected coverage
requires executed tests. Per-check coverage retains its declared profile; native
coverage does not imply WASM coverage. Reports and metrics are visibly
`customer_runner_reported`; this importer does not verify runtime/engine/artifact
identity or authorize preview/promotion. Aggregate test counts stay unknown if
any selected test command lacks structured results. CLI regression counts are
separate from your application test counts.

Reports are limited to 1 MiB and 10,000 tests per check, and 4 MiB across the
sequence. The importer rejects unknown fields, malformed UTF-8 and nonregular,
symlink or hardlinked inputs. It screens common credentials and terminal controls
in diagnostics, and removes temporary run context from receipts. Screening is
heuristic; omit sensitive data in your adapter. Cleanup removes only the fresh
temporary directory created for that check, preserving project-owned results.
Arbitrary local commands have your local permissions; this workflow is not a
hostile-code sandbox. The standard-runner adapters below, compiled-WASM checks
through the [local development toolkit](./dist/local-development/README.md),
and the IDE's **Tests → Inspect local test results** panel provide the local
workflow. Local preview/promotion preflight can require these results; hosted
activation separately requires a signed result with current resource custody.
Importing a local report does not grant that authority.

The Node `node:test` adapter is available through `runner: node` with `kind: test`,
`profile: native` and arguments such as `tests/app.test.mjs`. The CLI selects
`--test` and its bundled reporter; changing reporter or execution mode through
runner arguments is rejected. The explicit `@blinkhost/cli/test/node-reporter`
export also remains available for customer-owned command configurations.
Add `--experimental-test-coverage` to collect Node's native coverage metrics.
This adapter is locally qualified on Node 22.23.3. It reconciles
root and file-level counts with individual terminal events, excludes empty-file
checks and suites, includes nested test
cases, and treats skip/todo as skipped. Cancelled child tests remain failures.
Missing final summaries fail the adapter, and it refuses WASM/browser labels.

Select the packaged Python standard-library `unittest` adapter with
`runner: python-unittest`:

```json
{
  "schema": "blinkhost.local-test-config/v1",
  "checks": [{
    "id": "python-unit",
    "target": "project",
    "cwd": ".",
    "runner": "python-unittest",
    "args": ["discover", "-s", "tests"],
    "kind": "test",
    "profile": "native",
    "results": { "format": "blinkhost/v1" }
  }]
}
```

Ordinary unittest discovery, explicit test names, name filters and failfast flags
are supported. Each declared parent test produces one record; subtest failures
fail their parent and subtests do not inflate counts. Expected failures are
skipped, unexpected successes are failures, and empty discovery reports no
tests. Collection and class/module fixture failures fail the command without
inventing test records. Cancellation never produces a successful report.
Reports have a 10,000-test/1 MiB bound, screen common credentials and run context,
and never overwrite a result file. Native coverage defaults to `not_collected`; this
adapter does not report WASM or browser coverage. The current local qualification
uses Python 3.12.3 on Linux; other Python/platform combinations remain unqualified.
The runner uses customer test code and Python's standard library independently
of BlinkHost account, database and mail services. Local process cleanup is not a
security sandbox; use isolated resources for untrusted application tests.

To collect native Python line and branch coverage, add `coverage.py` 7.x to your
application's test environment and opt in through the check arguments:

```json
"args": ["--coverage=app", "discover", "-s", "tests"]
```

Use the package dependency `coverage` (locally qualified at version 7.10.7).
Repeat `--coverage=relative-directory` for up to 16 source directories inside the
check's working directory. Bare `--coverage` measures that whole directory;
prefer explicit application folders to avoid counting test code or dependencies.
Coverage includes discoverable Python source files within those folders even if
tests never import them. Missing, empty, absolute or escaping directory values
are rejected before test discovery. The adapter ignores `.coveragerc`, retains
only bounded numeric totals and writes no coverage database or JSON report file.
No function totals, subprocess/multiprocessing aggregation, browser coverage or
WASM coverage are provided. Instrumentation runs within the check's existing
time and memory limits.

Missing or unsupported dependencies, instrumentation/report errors and empty or
skipped-only suites report `unavailable`. Test outcomes keep their actual
meaning: coverage cannot make a failed test pass. Hosted offline checks use the
same adapter with a locked pure Python wheel bound to the selected module's SBOM;
the worker does not download or install the dependency during test execution.

The Go adapter runs ordinary native `go test -json` with `runner: go`. Select package patterns
and Go test flags as literal arguments:

```json
{
  "schema": "blinkhost.local-test-config/v1",
  "checks": [{
    "id": "go-unit",
    "target": "project",
    "cwd": ".",
    "runner": "go",
    "args": ["-count=1", "./..."],
    "kind": "test",
    "profile": "native",
    "results": { "format": "blinkhost/v1" }
  }]
}
```

Install Go on your PATH and run this through `blinkhost test`. The adapter
validates the native profile before invoking Go. It forwards selection, repeat,
parallelism, timeout and failfast flags. Each completed Go parent test, subtest
and repeat produces its own record, as reported by Go; package build/execution
checks never count as application tests. Empty/skipped-only packages remain
explicit. Failed package exits fail the check, even if no tests were declared.
Missing package/test terminal events and interrupted runs cannot supply passing
reports. Native coverage is `not_collected`, including when Go's `-cover` prints
a percentage; the adapter does not turn percentages into invented counts.

Compile-only, list, benchmark, fuzz and custom execution modes are rejected.
Inherited `GOFLAGS` is cleared to preserve the structured runner mode; put your
ordinary test flags in the configured argument list. Cross-compiled GOOS/GOARCH
profiles are refused. Go's `./...` excludes nested Go modules; declare separate
checks with their module directories to include them. Dependencies, toolchain
downloads and customer test effects follow your own Go configuration and local
permissions. No BlinkHost account/mail/database service is used by this adapter.

Result bounds remain 10,000 tests and 1 MiB; event parsing additionally caps each
JSON event and retained test diagnostic at 64 KiB, the event stream at 32 MiB,
and retained diagnostics at 4 MiB. Oversize/incomplete results fail. Common
credentials, terminal controls and run context are screened before diagnostic
truncation, and fresh private results never overwrite existing files. The parent
CLI owns timeout/output budgets and process-group cleanup. The local qualification
targets Node 22.23.3 and Go 1.27.3 on Linux; other versions/platforms, hostile-code
isolation and actual compiled-WASM execution retain separate validation gates.

Select the stable Rust adapter with `runner: rust`; it is also exported as
`@blinkhost/cli/test/rust-runner`. It uses Cargo JSON build records to discover
native unit/integration test binaries, then reconciles each stable libtest result
with a separate selected-test census, ignored-test census, summary and exit code.
It does not require nightly Rust or `RUSTC_BOOTSTRAP`. Install Rust/Cargo locally:

```json
{
  "schema": "blinkhost.local-test-config/v1",
  "checks": [{
    "id": "rust-native",
    "target": "project",
    "runner": "rust",
    "args": [],
    "kind": "test",
    "profile": "native",
    "results": { "format": "blinkhost/v1" }
  }, {
    "id": "rust-doc",
    "target": "project",
    "command": "cargo",
    "args": ["test", "--doc"],
    "kind": "test",
    "profile": "native"
  }]
}
```

Pass ordinary Cargo selection/features before `--`, and libtest filters, exact
selection, ignored/include-ignored or test-thread flags after it. Each native
test is counted once; ignored cases are skipped. Individual timing and native
coverage are unavailable and are not inferred from suite time or build success.
The separate doctest command has `command_exit_only` evidence, so aggregate test
counts remain unknown when it is included. Declare nested Cargo projects as
separate checks with their directories. Benchmarks, doctests inside the adapter,
cross targets, alternate output modes, uncaptured output and nightly options are
rejected. Custom harnesses and unsupported output formats fail closed.

Stable libtest text has no versioned machine contract; this adapter's local
qualification targets Rust 1.98.0/Cargo 1.98.0 with Node 22.23.3 on Linux. Other
versions/platforms remain unqualified. Every build/list/execution stdout is
bounded at 1 MiB, with the existing total CLI timeout/output and canonical result
bounds. Failed tests carry bounded screened per-test output. Cargo build scripts,
dependencies and tests use your local permissions and configuration; isolate
untrusted projects. This is native testing, with no BlinkHost internal services
and no compiled-WASM/libSQL/runtime certification.

Results include every configured check, bounded execution receipts and unrun
checks after the first failure. Nested `blinkhost.yaml` projects are discovered
and reported as unrun; use `blinkhost test path/to/project` to run each explicitly.
Discovery skips dependency/build/cache directories and directory symlinks. It
reports incomplete discovery after eight levels, 2048 directories, 16384 entries
or 128 nested projects. Review unexplored directories before treating the check
set as complete. Discovery does not execute discovered projects.

For a local required-check preflight, add `blinkhost.gates.json` and run
`blinkhost test . --gate preview --json` or `--gate promotion`. Configure explicit
structured checks in `blinkhost.tests.json`, using installed runners or the
`blinkhost/v1` result protocol. The selected stage requires every named check to
exit successfully, report at least one passing test, and report zero failed,
skipped or unsupported tests. A build or a successful command without a valid
test report cannot satisfy a required check. All configured commands still run;
the selected stage determines which reports must contain only passing tests.

```json
{
  "schema": "blinkhost.local-test-gates/v1",
  "inputs": {
    "source": ["src/app.ts", "tests/app.test.ts"],
    "artifacts": [],
    "dependencies": ["package.json", "package-lock.json"],
    "runtime": ["runtime.json"],
    "resources": ["resources.json"],
    "fixtures": ["fixtures/customer.json"]
  },
  "stages": {
    "preview": ["unit"],
    "promotion": ["unit", "integration"]
  }
}
```

Adapt file paths and check names to your application. All six input categories
must be present; source must contain at least one file. List individual regular
files using relative paths with letters, digits, `_`, `.`, `@`, `-` and `/`.
Directories, glob patterns, duplicate paths, path traversal and symlinks are
rejected. Keep changing output/log files outside the declared input set. The CLI
includes `blinkhost.yaml`, `blinkhost.tests.json` and `blinkhost.gates.json`
automatically, and snapshots the Node binary, relevant CLI/adapter files and
resolved check executables. It compares selected input hashes before and after
the checks. A changed, removed or unavailable input blocks the local gate;
changed executable bytes or resolution also block stale local evidence.
Configuration replacement during setup is rejected. Duplicate JSON keys are
invalid in the gate policy.

Gate configuration is limited to 64 KiB and declared inputs to 1,024 files.
Snapshot reads allow at most 256 MiB per file and 512 MiB total, including CLI
tools. Setup, snapshots and commands share the selected `--timeout`. The
`local_gate` receipt records stage, passed/blocked status, input hashes and each
required check's outcome. Local gates currently qualify Linux only.

This preflight is **customer-runner-reported local evidence** with
`scope: declared_local_inputs` and `production_authority: false`. You must list
the application inputs you intend to check. It does not establish complete
dependency, environment or dynamic-library coverage, and before/after snapshots
cannot detect temporary changes reverted during execution. It does not run a
remote preview, authorize promotion or attest an isolated worker execution.
Trusted preview/promotion enforcement requires the separate server-side test
stages. Ordinary `blinkhost test` behavior is unchanged without `--gate`.

Local commands share a default 900-second timeout and 1 MiB of combined
stdout/stderr. Use `--timeout 120` (1–3600 seconds) and
`--max-output-bytes 1048576` (1024–8388608 bytes) to choose other bounds.
The timeout and output allowance apply to the whole configured sequence.
Commands receive no interactive stdin. Timeouts, cancellation and output
overflow fail the check; overflow never becomes a successful truncated result.
SIGINT exits 130 and SIGTERM exits 143.

Execution receipts include bounded stdout/stderr after screening common
credentials and terminal controls. Output is collected before display, with no
raw subprocess streaming; `--json` emits one response including the receipt.
Screening is not exhaustive, so review results before sharing. POSIX cleanup
covers the owned process group, while Windows cleanup covers the direct child.
Local commands run with your machine permissions; these controls are not a
security sandbox or CPU/memory isolation. The command performs no update checks.
Result delivery waits at most three seconds for successful output or one second
for failure/cancellation output. Closed or stalled pipes exit 4. Interrupting
result delivery can leave an incomplete response; SIGINT/SIGTERM still exit
130/143 after owned-command cleanup.

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

The default portable export requires a supported frontend configuration. For
backend-only projects, or to download source without generating build files, use:

```bash
blinkhost projects export PROJECT_UUID --source-only --output ./source.zip --json
```

Source-only mode preserves workspace files and validated project assets, including
any existing configuration. It does not generate or validate build configuration,
README files, database schemas or lockfiles. A connected repository's saved base
is overlaid with the workspace; files outside the application root are preserved.
It is not a fresh fetch of the remote branch. The server must explicitly confirm
source-only mode, so an older server cannot silently return generated files.
The same authorization, credential screening and size limits apply in both modes.
Known configuration and credential-screening errors include next steps and a
request ID; raw server details are not printed. Export never repairs your stored
configuration, installs dependencies or changes source on your behalf.

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
blinkhost deployments preparation-diagnostics DEPLOYMENT_ID --project PROJECT_UUID
blinkhost modules list --query site_id=PROJECT_ID
blinkhost databases list --query project=PROJECT_ID
blinkhost organizations get ORGANIZATION_ID
```

`deployments preparation-diagnostics` shows recorded native compiler failures for
the selected release and project, including validated measured sizes and platform
preparation budgets. These are past attempt facts; they do not confirm current
serving health or native readiness. Changing plans does not increase platform
compiler limits. The command only reads, does not retry or prepare modules, and
displays unavailable details safely. `--json` returns the same bounded projection.

Create and update operations accept a JSON object or `@path` to a JSON file:

```bash
blinkhost projects create --data @project.json
blinkhost deployments action DEPLOYMENT_ID rollback --data @rollback.json --idempotency-key SAVED_REQUEST_KEY
```

For activate, promote, retry and rollback, save a unique request key before the
first command. Keys accept 8–128 letters, digits, dots, underscores, colons or
hyphens. If the response is lost, use the same account and profile to inspect
the original request:

```bash
blinkhost deployments publication-lookup --idempotency-key SAVED_REQUEST_KEY
blinkhost deployments publication-status OPERATION_ID
```

These recovery commands only read status. A new key starts a separate request;
do not replace a key because of a timeout. Publication success confirms the
control-plane commit. Inspect `result_status` and `result_is_current` to check
release propagation and current routing.

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
blinkhost logs --project PROJECT_ID --follow --severity error --max-events 1000
blinkhost logs --project PROJECT_ID --preview-session-id SESSION_UUID --json
blinkhost logs --project PROJECT_ID --attribute-filters '[{"path":["order","id"],"op":"eq","type":"integer","value":18446744073709551615}]' --json
blinkhost metrics --project PROJECT_ID --since 24h
blinkhost analytics --project PROJECT_ID
blinkhost doctor
blinkhost support bundle
```

Logs use the linked project when `--project` is omitted. `--since` accepts a
positive integer followed by `s`, `m`, `h` or `d` (up to 366 days), or a
timezone-aware ISO timestamp with at most millisecond precision. It sends a
fixed `start_time` to the API. Alternatively use `--hours N`, or `--start-time`
and `--end-time`; the start is inclusive and the end exclusive. The service
enforces current permissions, retention and plan query bounds. The default
lookback is one hour. Metrics and analytics accept duration `--since` values
and round them up to whole hours; they do not accept absolute timestamps.

Log filters include `--severity`, `--event-kind`, `--search`, `--request-id`,
`--trace-id`, `--source`, `--operation`, `--outcome`, `--status-code`, `--region`,
`--release-id`, `--environment-kind`, `--environment-id`, `--deployment-id`
and `--preview-session-id`. A preview session implies the preview environment
and cannot combine with deployed environment/deployment IDs. Custom
`--attribute-filters` use the same bounded typed JSON predicates as the
dashboard and API. Quote exact 64-bit integer JSON in the shell as above;
generating it with a JavaScript `Number` can round it before the CLI receives it.
Run `blinkhost logs --help` for command examples and options.

History reads newest first, one page at a time. `--limit` is the page size
(1–200, default 100); `--max-events` is the total output bound (1–10,000,
default 200 for history and 10,000 for follow). History also stops after
1,000 pages or 120 seconds. A cutoff summary includes `has_more`, `next_cursor`
and the effective filters. Continue with `--cursor` and exactly those filters,
using the summary's `--start-time` instead of recomputing `--since`. Cursors
are scoped and may expire. Concurrent ingestion and retention can change
history between pages.

`--follow` uses an authenticated scoped ticket, polls every 2.5 seconds, reads
at most ten pages per poll and remembers at most 1,000 IDs for deduplication.
It retries transient failures at most three times with bounded backoff, and
stops on permission errors, ticket expiry, the event bound or interruption.
Notices identify reconnects and unconfirmed continuity; late arrivals and
full windows can leave gaps. Use retained history to inspect an interval.
Ctrl-C/SIGINT and SIGTERM exit with 130 and 143, respectively. Cancellation
targets only the current owned query and ticket closure is attempted with an
independent timeout; unconfirmed cleanup is reported when output is available.
Output is awaited before fetching another page. Interrupting a stalled pipe
can leave its final line or summary incomplete; a closed pipe exits with code 4.
Logs do not perform background update checks.

With `--json`, logs emit newline-delimited JSON: `{"kind":"event","event":...}`,
`{"kind":"notice","code":...,"message":...}` and a final
`{"kind":"summary","events":...,"duplicates_skipped":...,"reason":...,"filters":...,"has_more":...,"next_cursor":...}`.
A failed command may follow emitted records with the standard `ok:false`
error object and exits nonzero. Stored attribute JSON preserves exact integer
tokens when available; otherwise `precision_notice` identifies the fallback.
Use an integer-preserving parser downstream. Text mode prints quoted
time/severity/message and exposes terminal controls and embedded newlines.

Support bundles are local, redacted JSON files with mode `0600`. They exclude tokens, secret values, source code, filenames, and repository URLs.

## CI and automation

All commands support `--json`. In JSON mode, stdout contains one response object on success or failure, except `logs`, which emits the NDJSON stream described above, and local-stack `dev`, which emits readiness and final records; subprocess and human diagnostics use stderr. Register one exact GitHub branch, tag, or protected environment as a workload identity, then grant the workflow `id-token: write`. The CLI exchanges GitHub's signed OIDC assertion for a ten-minute BlinkHost token automatically; no BlinkHost secret is stored in GitHub.

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
  --certificate-identity "https://github.com/blinkhost-ltd/blinkhost-cli/.github/workflows/release.yml@refs/tags/v2.5.2" \
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
