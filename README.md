# BlinkHost CLI

The BlinkHost CLI creates and validates portable projects before you connect them to BlinkHost. It uses the same `blinkhost/v1` manifest contract as the control plane.

## Requirements

- Node.js 22.12 or newer
- Git for repository workflows
- npm, pnpm, Yarn or Bun for dependency installation; use `--no-install` when working offline

## Install

```bash
npm install --global https://github.com/blinkhost-ltd/blinkhost-cli/releases/download/v1.0.0/blinkhost-cli-1.0.0.tgz
blinkhost --version
```

## Create a project

```bash
blinkhost create study-circle --template react
blinkhost create study-circle --template astro --module search:rust --module reminders:python --database PRIMARY_DB
```

Supported frontend templates are `astro`, `html`, `react`, `solid`, `svelte` and `vue`. Backend modules may use `go`, `python` or `rust`. Package dependencies and the required lockfile are installed by default with lifecycle scripts disabled. Use `--no-install` for an offline scaffold, then create and commit the selected package-manager lockfile before connecting the repository.

`create` accepts a safe project name beneath the current directory and refuses to overwrite any existing path. It writes the project through an isolated staging directory and renames it into place only after every file succeeds.

## Adopt an existing repository

```bash
cd existing-project
blinkhost init
blinkhost validate
```

`init` detects supported frontend metadata and writes `blinkhost.yaml`. Review the manifest before connecting the repository. It does not provision resources, upload source or copy credentials. Use `--force` only when you have reviewed and intend to replace an existing manifest.

## Validate and diagnose

```bash
blinkhost validate
blinkhost manifest --json
blinkhost doctor
```

Validation rejects unknown manifest fields, duplicate YAML keys, YAML aliases, path traversal, reserved cross-platform names, unsafe symbolic links, duplicate module names and secret values outside the supported name-only declaration. It also verifies declared frontend, backend-module and database paths.

All commands support `--json`. Stable process exit codes are:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid command or option |
| 3 | Manifest, project or environment validation failed |
| 4 | Filesystem or dependency-install operation failed |
| 5 | Unexpected internal failure |

## Security boundary

The v1 CLI is deliberately credential-free. It does not store BlinkHost access tokens or perform deployments. Connect and deploy through the BlinkHost dashboard, where organization roles, plan limits, review rules, protected environments and release evidence remain authoritative. Never add secret values to `blinkhost.yaml`; declare names and configure values in BlinkHost.
