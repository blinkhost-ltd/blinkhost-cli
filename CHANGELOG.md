# BlinkHost CLI changelog

This file records customer-visible CLI changes. BlinkHost uses semantic versioning for the CLI, while security and migration impact are classified separately. A patch may therefore require prompt action, and a major release may coexist with an earlier supported line during its documented migration window.

## Unreleased — Idam staff preview

- Added safe, actionable source-export guidance for unsupported frontend
  configurations, HTML package/lockfile issues and credential-screening blocks.
  Error bodies are bounded and never printed; unknown failures retain their HTTP
  status and request ID. Offline help documents the backend-only export limit.

- Fixed source exports returning HTTP 406 during API content negotiation.
  Successful downloads still require a complete ZIP archive; JSON responses
  cannot be saved as source exports.

- Fixed upload requests combining the default JSON content type with an explicit
  multipart or binary content type, which could cause HTTP 415 errors. Custom
  headers now replace defaults regardless of capitalization. Failed uploads are
  still not retried automatically.

- Sign-in now explains expired codes and how to request a new one. Authorization
  polling backs off when requested by the server and stops at expiry; uncertain
  token-delivery or network failures are not retried automatically. Sign-in
  addresses are validated before display or browser launch, and malformed token
  responses cannot overwrite a saved credential.

- Corrected offline workflow help: approving a plan requires `ai:approve`,
  separate from `ai:execute` for drafting, revising and stopping it.

- Added `projects export PROJECT_UUID --output ./project.zip` for source ZIPs,
  distinct from Idam task exports. Existing authorization and secret screening
  apply. Bounded downloads refuse redirects and overwrites; nothing is extracted
  or executed. Database rows, runtime secrets and running deployments are excluded.

- Added backend starter choices, file review, explicit save approval and read-only
  receipt recovery. Normal permissions, source revisions and module limits apply.
  No builds, publication or AI charges; uncertain saves are never auto-retried.

- Added saved-module build choices, review, explicit approval and read-only status.
  Normal compiler rollout, plan capacity and build metering remain authoritative;
  no AI credits are used. Approval never publishes. CLI scope, exact digest and
  review confirmation are required; uncertain responses are never auto-retried.

- Added explicitly confirmed `ai resume` for eligible multi-step checkpoints.
  It preserves active work, retry delays, original spending limits and receipts;
  it cannot restart stopped tasks or approve changes. Requires `ai:execute`.
  Ambiguous responses are not retried automatically; inspect task status.

- Added `ai sources --project PROJECT_UUID` and bounded `research_source_ids`
  selection for research requests. Reviewed excerpts are inspectable in task
  details and exports, with attribution and citation status. This is not live
  web search; sources are checked before admission and dispatch and count toward
  the existing credit estimate. The separate source gate remains off by default.

- Extended declaration review to bounded `requirements.txt` files. Python server
  frameworks and selected native packages receive qualified guidance, not a
  promise of runtime support. Includes, URLs and pip options are not followed;
  environment markers and extras are not evaluated. No code runs or changes.

- Task exports identify the reviewed file selection separately from the full
  proposal. An applied timestamp records a save, not a successful build or the
  current contents of files. Review contents and approval tokens stay excluded.

- Made invisible direction and terminal controls visible in source review diffs.
  Approval hashes still bind the original source. Structured CLI output uses
  JSON escapes that preserve decoded values, including filenames and source.

- Added `ai compatibility --project PROJECT_UUID`: a read-only, revision-bound
  declaration review with explicit inspection limits and no runtime certification.
  Requires `ai:read`; no uploads, model calls, credit reservations or source edits.

- Added optional personal project guidance with `ai memory-show`, `memory-save`
  and `memory-clear`. Saving uses an explicitly selected, bounded UTF-8 file,
  reviewed version and project confirmation. Changes stop queued work using
  older guidance; clearing does not erase existing task records or backups.
- Workload identities are refused across the personal Idam preview, so automated
  jobs cannot inherit the creator's guidance, history or source approvals.

- Added `ai workflow-plan`, `workflow-revise`, `workflow-approve`, `workflow-status`
  and `workflow-cancel` for bounded investigation-and-review drafts. Saving and
  editing do not start follow-ups. Approval binds the inspected revision and
  digest with exact workflow confirmation. `workflow-start` is a draft-only
  compatibility alias. Saved version history remains available on each task.
  Separately gated and disabled; no tools, tests, source writes or deployments.

- Added `ai rollback-review` and `ai rollback-approve` for an explicitly reviewed,
  source-only undo. Later file edits are protected; unchanged new files are removed
  only when no active co-editing session references them. Original history and
  charges remain unchanged. This is not deployment rollback or project recovery.

- `ai export` now retrieves a versioned, private task snapshot with credit totals,
  removal status and explicit history limits. Proposed source is opt-in with
  `--include-source`; internal context, approval tokens and input files are excluded.

- Optional, explicitly selected workspace source files for a task, with credential
  screening and byte limits before funding. No implicit local-file upload.

- Added `ai start`, `list`, `status`, `events`, `export`, `review`, `approve` and `cancel`.
- Start requests use a bounded JSON file with a stable request ID and explicit budget.
- Source approval requires the reviewed action digest and exact task confirmation;
  saving does not build, test, publish, purchase resources or create a Git commit.
- Added repeated `auth login --scope` for explicit AI permissions. Existing sessions,
  default sign-ins and workload identities do not receive AI permissions automatically.
- Included offline `docs ai` with scope, privacy, retry and verification limits.

These commands require the unreleased control-plane integration and authorized staff
pilot access. They are not available in the published 2.4.0 package and do not enable
Idam for customers. No project migration or automatic update is performed.

## 2.4.0 — 2026-09-02

### Added

- Terminal-accessible release notes from BlinkHost's immutable public release registry.
- Cached, non-blocking update notices with package-manager-specific instructions.
- Dashboard-linked compatibility guidance for confirmed CLI and SDK versions.

### Changed

- Token refresh reports the installed CLI version so upgrading does not leave stale session evidence.
- Routine notices remain in the CLI and dashboard; required, security and retirement impact use targeted operational communication.

### Compatibility

- Node.js 22.12 or newer.
- No project migration is required from 2.3.0.

## 2.3.0 — 2026-08-31

### Added

- Project-scoped `functions status` capability discovery.
- Direct trigger, invocation, result, cancellation and retry workflows.

### Security and reliability

- Function payloads are bounded JSON objects.
- Retries support explicit idempotency keys.
- Update checks never install software and do not block CI or structured output.

### Compatibility

- Node.js 22.12 or newer.
- Backend SDK contract 1.1.0.
- No migration is required from 2.2.0.

## 2.2.0 — 2026-08-30

### Added

- JavaScript, TypeScript and Python Function workflows with explicit beta availability.
- Commands for background, event and scheduled triggers.

### Changed

- Function availability became project- and rollout-aware rather than inferred from the installed CLI version.

## 2.1.0 — 2026-08-29

### Added

- Public npm installation for `@blinkhost/cli`.
- Existing-repository detection, local validation, development and build checks.
- Device authorization, named profiles and revocable CLI sessions.
- Workload identity support for secretless GitHub automation.

### Security

- Refresh credentials are stored in the operating-system credential service.
- Secret values are accepted through standard input rather than command arguments.

## 2.0.0 — 2026-08-29

### Added

- Stable command groups for projects, source connections, previews, builds, deployments, backend modules, databases and organizations.
- Machine-readable JSON output and stable exit categories.
- Explicit confirmation for destructive operations.

## Compatibility and support policy

- BlinkHost documents supported Node.js, manifest, runtime, ABI and SDK versions with each release.
- Deprecations include an alternative and a published deadline before removal unless an active security issue requires faster action.
- Required and security migrations identify affected versions and link to a tested guide.
- Run `blinkhost update check` for the current version comparison or `blinkhost update notes [VERSION]` for release detail.
