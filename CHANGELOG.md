# BlinkHost CLI changelog

This file records customer-visible CLI changes. BlinkHost uses semantic versioning for the CLI, while security and migration impact are classified separately. A patch may therefore require prompt action, and a major release may coexist with an earlier supported line during its documented migration window.

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
