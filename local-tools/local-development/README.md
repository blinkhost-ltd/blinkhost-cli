# Run your application with a local backend and libSQL

The Linux local stack serves your built frontend, runs your portable backend module in WasmEdge, and connects it to a fresh libSQL database. You can also run scripted email, payment and AI providers alongside your app. It uses loopback listeners and requires no BlinkHost login.

## Install the development tools

Use 64-bit x86 Ubuntu 24.04 with OpenSSL 3, the Ubuntu `ca-certificates` package and Node.js 22.12 or later. The local libSQL server loads the system certificate store during startup. Download `blinkhost-local-runtime-2.8.0-linux-x86_64.tar.gz` from the runtime release. Download `local-runtime.SHA256SUMS` and `local-runtime.SHA256SUMS.sigstore.json` from the CLI v2.8.0 release. [BlinkHost local runtime](https://github.com/blinkhost-ltd/blinkhost-cli/releases/tag/local-runtime-v2.8.0) · [CLI v2.8.0 signed checksums](https://github.com/blinkhost-ltd/blinkhost-cli/releases/tag/v2.8.0)

In your application directory, verify the checksum list's signature using Cosign, then verify the archive before extracting the runtime and its matching WasmEdge 0.18.1 library.

```sh
archive=blinkhost-local-runtime-2.8.0-linux-x86_64.tar.gz
cosign verify-blob \
  --bundle local-runtime.SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/blinkhost-ltd/blinkhost-cli/.github/workflows/release.yml@refs/tags/v2.8.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  local-runtime.SHA256SUMS &&
  awk -v name="$archive" '$2 == name' local-runtime.SHA256SUMS | sha256sum --strict --check - &&
  printf '%s  %s\n' 8075e5b2224e725fda002aba8239de8ce3d4c80105df44f3e6fa288443715ae9 "$archive" | sha256sum --strict --check - &&
  mkdir -p tools && tar -xzf "$archive" -C tools
```

The CLI package contains the launcher and configuration examples. The backend stack requires the separate runtime and engine. You can use native application tests with `blinkhost test .` and run your frontend's configured development command with `blinkhost dev .` independently.

Install upstream `sqld` 0.24.32 for Linux x86-64, verify its published asset checksum and put the executable in `tools/sqld`. [libSQL server 0.24.32 downloads](https://github.com/tursodatabase/libsql/releases/tag/libsql-server-v0.24.32)

Copy the configuration example from your installation to your application. For a globally installed CLI, run the following from the project directory.

```sh
cli_tools="$(npm root -g)/@blinkhost/cli/dist/local-development"
cp "$cli_tools/blinkhost.local.example.json" blinkhost.local.json
mkdir -p local-data
```

For a project-local installation, the examples are under `node_modules/@blinkhost/cli/dist/local-development/`. Set `runtime.path`, `engine.path`, `database.executable.path`, `artifact.path` and `frontend` to your files. The engine path must use the shared library name `libwasmedge.so`. Use `sha256sum` on each of the four input files to fill its matching `sha256` field. The runtime and engine digests must match the verified distribution. Relative paths resolve against the configuration file. Build your frontend into the public directory that you set as `frontend`.

## Build your first portable backend module

The package includes a complete Rust HTTP handler that returns `Hello from BlinkHost!`. It compiles with stock Rust and uses the runtime's response function directly. You can edit its status, headers and body. From your application directory, use `cli_tools` from above or set it to `node_modules/@blinkhost/cli/dist/local-development` for a project-local install.

```sh
rustup toolchain install 1.98.0 --profile minimal --target wasm32-unknown-unknown
cp "$cli_tools/hello.rs" hello.rs
rustc +1.98.0 --edition=2024 --target wasm32-unknown-unknown \
  -C opt-level=s -C panic=abort -C strip=symbols hello.rs -o artifact.wasm
sha256sum artifact.wasm
```

Copy that digest into `artifact.sha256` in `blinkhost.local.json`. For a new project you can start with `blinkhost create hello --template html --no-install`. In that project's directory, `mkdir -p frontend && cp index.html script.js style.css frontend/` prepares the static frontend for the example configuration. After the stack prints its frontend origin, open `/api/hello` at that origin to see the handler's response.

For your own language toolchain, you can also supply an executable compiler wrapper as described below. The dashboard's **Build** action compiles a saved module on BlinkHost and reports its build status and artifact digest. Local execution requires a portable module on disk. The generated JavaScript and TypeScript handlers use BlinkHost's request and response adapter during compilation. Building those handlers for local use requires a compiler with that adapter. Stock Javy alone can emit a module that starts and returns an empty body.

## Start and stop the stack together

The launcher starts `sqld`, applies your setup statements, starts the runtime, verifies its health and connects the frontend. It checks the runtime contract, engine version and the hashes of your configured inputs.

Choose a **new** state directory whose parent already exists, outside the served
frontend directory:

```sh
blinkhost dev . --local-config ./blinkhost.local.json --state-dir ./local-data/run-001 --json
```

The installed CLI packages this tool and validates `blinkhost.yaml` before
startup. Both local options are required; it makes no account/update API requests.
It emits a JSON readiness record followed by the final shutdown result. Ctrl-C
or SIGTERM after readiness exits zero; interrupted startup and child failures
exit nonzero. Readiness output waits at most three seconds, final output one
second; incomplete output fails after stopping owned processes. An idle closed
pipe may be detected only on the next write.

The JSON output contains the actual frontend, runtime and database origins.
Listeners bind to `127.0.0.1` on operating-system-selected ports, discovered from
sockets owned by each child through Linux `/proc`. Open the printed frontend URL.
You can also use those origins in the browser test configuration below. Run a
second stack with another state directory to test isolated projects.

Ctrl-C or SIGTERM stops the owned module, database and frontend. A startup or
child-process failure stops its companions. The state directory retains the
database, bounded process logs and private `ready.json`/`stopped.json` evidence;
the tool never deletes data or resumes/resets an existing directory. Logs retain
at most 1 MiB per process; stop evidence reports dropped bytes. A new run with
the same setup gives a fresh fixture without erasing the previous run. Setup
uses real Hrana results, and an SQL error fails startup even with HTTP 200.
Setup SQL is customer-controlled privileged development code; review it as you
would an ordinary migration. Bound Hrana null/integer/float/text/blob arguments
are supported. Configuration is limited to 64 KiB and 128 setup statements.

The child environment supplies only explicit tool/library/temp paths and locale,
without inheriting cloud/account/libSQL credentials or service configuration.
This entry point defaults to the read-only Free local profile described below.
Native database operations and guest provider access require the separate
explicit grants described below. Compile
your artifact separately; `--watch-artifact` can replace that compiled artifact
as described below. Source compilation and coverage use separate tooling. This
entry point grants no deployment authority. The local profile has a 20,000,000-byte portable artifact limit and a 128 MiB guest memory limit. Set `limits.max_concurrent` from 1 to 10 (default 4). Request and response bodies are each bounded to 5,000,000 bytes. The request budget includes upload, preparation and execution. Set `limits.request_timeout_ms` from 1 to 30,000 milliseconds (default 30,000). Expiry returns HTTP 504, and the separate five-second upload limit returns HTTP 408. A disconnected request may occupy its slot until guest execution stops.

## Reload a separately compiled artifact

Add `--watch-artifact` to the installed CLI's explicit local stack command:

```sh
blinkhost dev . --local-config ./blinkhost.local.json --state-dir ./local-data/run-002 --watch-artifact --json
```

After compiling a new portable WASM module, update `artifact.path` and
`artifact.sha256` together in the configuration. Atomic file replacement is
supported. The watcher polls every 500 milliseconds; it does not watch source
files or invoke a compiler. An identical artifact digest starts no new runtime.
Tools, setup SQL, limits, frontend, native permissions and provider declarations
must stay unchanged. Change those by starting a fresh stack instead.

The owner captures verified private artifact bytes, starts a candidate and
checks its engine, digest, memory, limits, database scope and provider grant.
It pauses new frontend API work with HTTP 503 and `Retry-After: 1`, waits for
in-flight frontend work and old execution slots to drain, then stops the old
runtime before publishing the candidate. It checks the configuration again
after draining. The frontend URL, physical database, native scope, provider
listeners and scripted provider sequences survive replacement; setup SQL is
not replayed. Static frontend files remain available during the pause.

JSON output emits `reloaded` or `reload_failed`. Invalid configurations, artifacts
or candidates keep the previous runtime running if it has not begun retirement.
A failure once retirement begins, or a candidate that cannot be stopped, fails
and stops the whole owned stack. Shutdown aborts pending reloads. Every real
candidate attempt retains private `reload-NNN.wasm`, `.log` and `.json` evidence;
validation errors before candidate creation are reported in the CLI event.
At most 32 real candidate attempts are allowed per stack. Start a fresh stack
to continue after that limit. Event output has a three-second bound; failed
output stops owned resources. An idle closed pipe may be detected on the next
write.



## Compile selected source files before starting

The installed CLI can invoke an explicitly configured compiler once before
starting the owned stack:

```sh
blinkhost dev . --local-config blinkhost.local.json --local-build-config blinkhost.build.json --state-dir local-data/run-002 --json
```

For example, a customer-prepared compiler wrapper can use this build config:

```json
{
  "schema": "blinkhost.local-source-build/v1",
  "source_root": "backend",
  "files": ["Cargo.toml", "Cargo.lock", "src/main.rs"],
  "command": { "path": "tools/compile-backend", "sha256": "REPLACE_WITH_VERIFIED_SHA256" },
  "args": [],
  "artifact": "module.wasm",
  "timeout_ms": 300000
}
```

Source roots/files stay inside the project and reject existing symlinks. Include
every application source file and build manifest the compiler needs. The config
is limited to 64 KiB, 1,024 explicit files and 64 MiB total source. Arguments are
literal; no shell expands them. A matching executable digest is required. The
wrapper is **trusted customer code**, with the local user's authority; this
command runner supplies bounds and process-group cleanup, rather than a security
sandbox. A wrapper using Docker or another service must isolate and stop its own
service resources, including cancellation. Use the pinned matching compiler,
SDK and offline dependencies for a production-like portable build.

The compiler runs in a fresh source snapshot. Its screened environment supplies
`BLINKHOST_LOCAL_BUILD_SOURCE`, `BLINKHOST_LOCAL_BUILD_OUTPUT` and
`BLINKHOST_LOCAL_BUILD_ARTIFACT`, along with a private `TMPDIR`, executable/system
`PATH` and locale/timezone. It does not inherit account/cloud credentials or
service configuration. Write the selected `.wasm` file to the supplied artifact
path. The default wall deadline is five minutes and the maximum is 15 minutes;
combined compiler output is bounded to 1 MiB. Native child-process groups stop
on failure, cancellation or output overflow.

After compilation, the CLI checks the executable, configuration and both the
original/copied source bytes again. It copies a regular portable artifact of at
most 20,000,000 bytes into private retained state. This build envelope checks the
portable header; the local WasmEdge runner subsequently performs its actual
artifact/resource/ABI admission before readiness. Compilation alone certifies
neither successful runtime admission nor application tests or coverage.

Use a new state directory outside both the served frontend and `source_root`.
It retains `build-001/build-result.json`, screened compiler output, source/output
files and `compiled-stack.json`; the running stack lives in `stack/`. Failed
builds retain their result and never start libSQL, runtime or frontend listeners.
The original stack/build configuration is preserved. Without `--watch-source`,
the source-build workflow runs once. It cannot be combined with
`--watch-artifact` in the same run.

## Watch declared source files

```sh
blinkhost dev . --local-config blinkhost.local.json --local-build-config blinkhost.build.json --state-dir local-data/run-003 --watch-source --json
```

The watcher checks the content of the initially declared source files once per
second. List every source/build input in the build configuration; it does not
discover new files or install dependencies. Rebuilds run serially in private
snapshots retained as `build-002/`, `build-003/` and so on. A successful compiled
candidate passes the same runtime admission and request draining used by
artifact reload. The database, native scope and provider response sequence stay
in place, and provider grants bind to the replacement artifact digest.

Compiler failures and invalid candidates retain the working module. Source and
configuration checks reject candidates whose inputs change before publication.
Another source edit triggers another attempt. The original stack configuration,
build configuration, source list, compiler and permissions must stay fixed;
configuration changes require a fresh development run.

JSON output adds `reloaded`, `build_unchanged` or `build_failed` events, also
retained in private `source-rebuild-NNN.json` records. At most 32 rebuilds and 64
normal events are allowed; a further change emits a final `build_failed` event
with `watching_stopped: true`. The running module remains available until you
stop the stack. Shutdown aborts and awaits the active compiler/reload. The final
command result includes the last successfully published build receipt. This
workflow supports portable artifacts; it does not certify AOT, native/WASM
coverage or production latency.

## Grant native DEFAULT database operations locally

Use a local runtime built with `customer-local-database`. Add a `native` object inside `database` alongside `executable` and your `setup` statements.

```json
"native": { "read": true, "write": true, "transaction": true }
```

All three booleans are required, and at least one must be true. Omission retains
the default denial of native operations. A build without the feature rejects
the grant. Choose the permissions needed by your application: a transaction
grant does not implicitly grant reads or writes. The compatibility DEFAULT read
binding remains separately available in this local profile.

The stack creates a new owned database, applies your privileged setup, then
installs protected receipt and database-state tables. It generates fresh database
and generation identifiers; it never adopts an existing state directory. The
readiness record's `native_database_scope` supplies those identifiers for SDK
calls, with environment `development` and namespace `customer-local`.
`native_database_permissions` records the selected grant. SDK writes require a
stable operation UUID and the current scope. Retry the same payload with the
same UUID, or reconcile its receipt before issuing a replacement operation.
Changed-payload replay fails. Write-only reconciliation reports commit status
while withholding receipt results with `receipt_results_require_read`.

Native calls use the existing gateway's SQL restrictions, permissions, budgets,
deadlines, scope checks, receipts and transaction cleanup. Guest SQL cannot alter
the protected tables, attach another database or perform schema administration.
Apply migrations and seeds explicitly through `database.setup` or owned local
Hrana tooling. Failed assertions roll back atomically; an abandoned interactive
transaction is rolled back before execution admission is released. Excess HTTP
concurrency returns 503 and does not create additional execution slots.



## Test customer email, payments and AI providers locally

When native transactions and provider grants are both enabled, outgoing HTTP
calls are blocked while an interactive database transaction is open. The SDK
reports `not_sent` with `external_effect_in_transaction`; the provider fixture
receives no request. Finish or roll back the transaction before calling a
provider. An abandoned transaction rolls back at guest exit, and its token
cannot be reused by another invocation.

A provider call after a database commit cannot undo that commit. A declined
payment, denied route, provider timeout, browser disconnect or local shutdown
may leave the earlier write committed. Reconcile the database receipt and the
provider's own outcome separately. Replaying a committed database operation
does not deduplicate a later HTTP call: use the customer's provider idempotency
key or a durable outbox for effects that must survive retries. An HTTP timeout
does not prove the provider rejected or failed to process the request.



Add optional `providers` to your local configuration. Each named fixture owns an
ephemeral loopback listener and matches an exact HTTP method and path. This
example returns a rate limit, then a successful email result:

```json
{
  "providers": {
    "email": {
      "routes": [{
        "method": "POST",
        "path": "/send",
        "responses": [
          { "status": 429, "headers": { "retry-after": "1" }, "body": "{\"error\":\"limited\"}" },
          { "status": 202, "body": "{\"id\":\"local-send\"}" }
        ]
      }]
    }
  }
}
```

Read `provider_fixtures.email` from the readiness record, and give that URL to
your application's native integration test or replaceable provider adapter.
These fixtures serve only their scripted responses: they never forward to a
real provider or use BlinkHost's internal email, payment, AI or identity systems.
They require no provider credentials. Declaring a fixture alone does not grant
the WASM guest outbound access. Browsers must use the exact fixture origin; cross-origin browser
requests are rejected.

To let your compiled module call selected fixtures, use a local runtime with `customer-local-providers` enabled. Include `customer-local-database` as well when testing native database operations. Add this top-level field beside `providers`.

```json
"provider_permissions": { "module": "customer-local", "fixtures": ["email"] }
```

Select only the declared fixtures your module needs. The stack generates a
grant from its newly started listeners, exact route methods/paths and the
compiled artifact digest. Read the origins from `provider_fixtures` in the
readiness record and pass them to your own replaceable application adapters.
The normal SDK structured, binary and streaming HTTP calls use those grants;
omission retains `outbound_http_disabled`. A binary without the development
feature rejects the grant before startup.

The guest can call only the selected owned IPv4 loopback origins and exact
methods/paths. Other projects' fixtures, unrelated local listeners, external
hosts, redirects, query strings and normalized or encoded paths are denied.
Do not include routing, framing or proxy headers in customer requests. The
runtime preserves its request/response byte bounds, invocation-owned stream
handles, deadlines and cancellation. Failed calls never retry automatically;
your adapter decides whether an explicit retry is safe. The readiness record's
`provider_permissions` and `provider_grant` show the selected local capability.


Binary and streaming response metadata includes valid `retry-after` hints:
up to ten decimal digits or a canonical GMT HTTP date. Other private/custom
provider headers remain filtered. A stalled provider can return
`outcome: "unknown"` with `error: "header_timeout"` inside your application's
HTTP 200 response before the whole module request deadline expires. This means
delivery is uncertain; do not treat it as confirmation that no effect occurred.



Each matched request consumes the next response after its body is received.
Parallel requests claim distinct steps in admission order. Exhaustion returns
409 unless the route sets `repeat_last: true`. A disconnected admitted request
still consumes its step, so tests can model retries without assuming an external
side effect happened exactly once. An optional `request_sha256` requires an exact
body digest; a mismatch returns 422 without consuming a step. Unexpected paths
return 404. Redirects and remote destinations are forbidden.

For streaming AI tests, replace `body` with `chunks` and use the SSE content type:

```json
{
  "status": 200,
  "headers": { "content-type": "text/event-stream" },
  "chunks": [
    { "body": "data: {\"token\":\"hello\"}\n\n" },
    { "body": "data: [DONE]\n\n", "delay_ms": 20 }
  ]
}
```

Response/chunk delays total at most 30 seconds. Definitions allow eight providers,
32 routes per provider, 32 responses per route and 64 chunks per response.
Request and response bodies are each limited to 64 KiB; fixture definitions have
a conservatively counted 1 MiB aggregate ceiling, within the existing 64 KiB
local configuration-file limit. Each listener admits 16 requests and 32 sockets;
excess admitted capacity returns 503. Incomplete headers and uploads expire after
five seconds. Only `content-type` and numeric `retry-after` response headers are
configurable.

Stopping the stack cancels fixture work and retains private
`provider-fixtures.json` beside the database evidence. It records route counters,
outcomes and request sizes/digests, without request payloads or headers. Each
provider retains 256 events and counts overflow. A fixture reporting a scripted
success proves only the local test behavior. It does not certify provider
delivery, billing, production availability or the guest provider path.

For a runnable example, merge the `providers` from
`provider-fixtures.example.json` into your local configuration and copy
`test-provider-example.mjs` into your application's root. Both files ship in the
CLI's `dist/local-development/` directory. Add this object to the `checks` array in
your `blinkhost.tests.json`.

```json
{
  "id": "customer-providers",
  "target": "project",
  "cwd": ".",
  "command": "node",
  "args": ["test-provider-example.mjs"],
  "kind": "integration",
  "profile": "native",
  "results": { "format": "blinkhost/v1" }
}
```

Set `BLINKHOST_LOCAL_PROVIDER_FIXTURES` to the readiness record's
`provider_fixtures` JSON object, then run `blinkhost test . --json`. The example
reports eight assertions and their durations, including body mismatch, retry,
declined payment and streaming AI responses. It uses the native profile because
these calls come from Node. Tests stop at the first failure and do not count
unexecuted assertions. Coverage remains `not_collected`. Start a fresh owned
stack for each run: the example consumes its scripted steps. Adapt the tests and
replaceable provider adapters to your application's behavior.



## Connect a browser and run integration checks

Open the exact frontend URL in the readiness record. The included proxy serves the configured public directory, forwarding `/api/PATH` to `/PATH` on your backend, with its original method, content type and body. It checks the browser origin and Host header. Cookies and authorization headers are omitted. The proxy also limits body sizes and rejects dotfiles, path traversal and symlinks escaping the public directory.

With a framework development server, configure its `/api/` proxy to the loopback runtime in the readiness record and enforce its own Host and Origin checks. Keep your listeners and database on loopback.

Run unit or integration checks with `blinkhost test .`. For a custom browser check that writes a structured report, add a check with `kind: integration`, `profile: browser` and `results: { "format": "blinkhost/v1" }` in `blinkhost.tests.json`. Supply the printed loopback origins to your own test code. Each state directory retains its database and private logs after Ctrl-C. Keep or remove those files according to the needs of your application.
