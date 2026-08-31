# BlinkHost CLI

The BlinkHost CLI brings project setup, local development, source control, previews, builds, releases, resources, and diagnostics into the terminal while BlinkHost continues to enforce workspace roles, plan limits, protected environments, verified artifacts, and audit history.

## Install

Node.js 22.12 or newer is required.

```bash
npm install --global @blinkhost/cli@2.3.0
blinkhost --version
```

Signed release archives, checksums, the CycloneDX SBOM, and Sigstore verification bundle are available at <https://github.com/blinkhost-ltd/blinkhost-cli/releases>.

## Start safely

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
blinkhost plugins add /absolute/path/to/plugin --name example
blinkhost plugins verify example
blinkhost plugins run example -- arguments
```

Update checks never install software. Plugins require explicit local approval, are pinned to their executable SHA-256 digest, stop when the executable changes, and receive neither BlinkHost credentials nor the parent environment. A plugin is still third-party code running with your operating-system account; review it before adding it.

Pin or roll back explicitly with `npm install --global @blinkhost/cli@VERSION`. Tagged packages are published from the `blinkhost-ltd/blinkhost-cli` release workflow through npm Trusted Publishing with provenance. To verify a downloaded GitHub release, first run `sha256sum --check SHA256SUMS`, then verify its Sigstore bundle:

```bash
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/blinkhost-ltd/blinkhost-cli/.github/workflows/release.yml@refs/tags/v2.3.0" \
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
