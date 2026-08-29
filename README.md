# BlinkHost CLI

The BlinkHost CLI brings project setup, local development, source control, previews, builds, releases, resources, and diagnostics into the terminal while BlinkHost continues to enforce workspace roles, plan limits, protected environments, verified artifacts, and audit history.

## Install

Node.js 22.12 or newer is required.

```bash
npm install --global @blinkhost/cli
blinkhost --version
```

Release archives and checksums are also published at <https://github.com/blinkhost-ltd/blinkhost-cli/releases>.

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

## Create or adopt a project

```bash
blinkhost create study-circle --template astro --module search:rust --module reminders:python --database PRIMARY_DB
cd study-circle
blinkhost validate
blinkhost projects link PROJECT_ID
blinkhost dev
```

Supported frontends are Astro, HTML, React, Solid, Svelte, and Vue. Backend modules may use Go, Python, or Rust. `blinkhost init` detects supported metadata in an existing repository and creates `blinkhost.yaml` for review.

Creation is atomic and refuses to replace an existing path. Dependency lifecycle scripts are disabled. Validation rejects unknown manifest fields, duplicate YAML keys, aliases, traversal, unsafe symbolic links, invalid cross-platform paths, duplicate module names, and missing declared inputs.

## Remote workflows

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

All commands support `--json`. Register one exact GitHub branch, tag, or protected environment as a workload identity, then grant the workflow `id-token: write`. The CLI exchanges GitHub's signed OIDC assertion for a ten-minute BlinkHost token automatically; no BlinkHost secret is stored in GitHub.

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
blinkhost plugins add /absolute/path/to/plugin --name example
blinkhost plugins verify example
blinkhost plugins run example -- arguments
```

Update checks never install software. Plugins require explicit local approval, are pinned to their executable SHA-256 digest, stop when the executable changes, and receive neither BlinkHost credentials nor the parent environment. A plugin is still third-party code running with your operating-system account; review it before adding it.

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
