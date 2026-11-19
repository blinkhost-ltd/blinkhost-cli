import { CliError, EXIT } from './errors.js';
import type { ScaffoldOptions } from './templates.js';

/** Native examples share application source with the guest entrypoint; host integration is separate. */
export function addLocalTestStarters(files: Map<string, string>, options: ScaffoldOptions): void {
  if (!options.modules.length) throw new CliError('--tests requires at least one backend --module.', EXIT.usage, 'missing_test_module');
  const checks: Record<string, unknown>[] = [];
  if (options.framework !== 'html') checks.push({ id: 'frontend-build', target: 'frontend', command: options.packageManager,
    args: ['run', 'build'], kind: 'build', profile: 'unspecified' });
  for (const [index, module] of options.modules.entries()) {
    const root = `_server_islands/${module.name}`;
    const nativeTests = `tests/native/${module.name}`;
    const check: Record<string, unknown> = { id: module.name.length <= 57 ? `${module.name}-native` : `native-${index + 1}`, target: `module:${module.name}`,
      kind: 'test', profile: 'native' };
    if (module.language === 'javascript' || module.language === 'typescript') {
      const entry = module.language === 'typescript' ? 'index.ts' : 'index.js';
      files.set(`${nativeTests}/handler.test.mjs`, `import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../../../${root}/${entry}';

test('handler preserves customer JSON and returns a JSON response', () => {
  for (const input of [null, false, { message: 'hello', values: [1, 2] }]) {
    const response = handler({ json: () => input });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(response.body), { ok: true, received: input });
  }
});

test('handler leaves request parsing failures observable', () => {
  const failure = new Error('invalid customer JSON');
  assert.throws(() => handler({ json: () => { throw failure; } }), error => error === failure);
});
`);
      Object.assign(check, { runner: 'node', args: [
        ...(module.language === 'typescript' ? ['--experimental-strip-types'] : []), `../../${nativeTests}/handler.test.mjs`] });
    } else if (module.language === 'python') {
      files.set(`${root}/application.py`, 'def response_payload():\n    return {"ok": True}\n');
      files.set(`${root}/main.py`, 'import blinkhost\nfrom application import response_payload\n\nblinkhost.respond(blinkhost.Response.json(response_payload()))\n');
      files.set(`${nativeTests}/test_application.py`, `import unittest
from application import response_payload


class ApplicationTests(unittest.TestCase):
    def test_response_payload(self):
        self.assertEqual(response_payload(), {"ok": True})

    def test_requests_do_not_share_mutable_payloads(self):
        earlier = response_payload()
        earlier["ok"] = False
        self.assertEqual(response_payload(), {"ok": True})
`);
      Object.assign(check, { runner: 'python-unittest', args: ['discover', '-s', `../../${nativeTests}`, '-p', 'test_*.py'] });
    } else if (module.language === 'go') {
      files.set(`${root}/application/response.go`, 'package application\n\nfunc ResponsePayload() map[string]bool {\n\treturn map[string]bool{"ok": true}\n}\n');
      files.set(`${root}/main.go`, `package main

import (
    "blinkhost.dev/sdk/go/blinkhost"
    "blinkhost/${module.name}/application"
)

func main() {
    response, err := blinkhost.JSONResponse(200, application.ResponsePayload())
    if err != nil || blinkhost.Respond(response) != nil {
        panic("BlinkHost response write failed")
    }
}
`);
      files.set(`${root}/application/response_test.go`, `package application

import "testing"

func TestResponsePayload(t *testing.T) {
    payload := ResponsePayload()
    if len(payload) != 1 || !payload["ok"] { t.Fatal("expected the application success payload") }
}

func TestRequestsDoNotShareMutablePayloads(t *testing.T) {
    previous := ResponsePayload()
    previous["ok"] = false
    if !ResponsePayload()["ok"] { t.Fatal("request payloads shared mutable state") }
}
`);
      Object.assign(check, { runner: 'go', args: ['./application'] });
    } else {
      files.set(`${root}/src/application.rs`, 'pub fn response_body() -> &\'static str {\n    r#"{"ok":true}"#\n}\n');
      files.set(`${root}/src/main.rs`, `mod application;
use blinkhost_sdk::{respond, Response};

fn main() {
    if respond(Response::json(200, application::response_body())).is_err() {
        std::process::abort();
    }
}
`);
      files.set(`${nativeTests}/Cargo.toml`, `[package]\nname = "${module.name}-native-tests"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n`);
      files.set(`${nativeTests}/src/lib.rs`, `#[path = "../../../../${root}/src/application.rs"]
pub mod application;

#[test]
fn response_body_is_the_application_success_payload() {
    assert_eq!(application::response_body(), r#"{"ok":true}"#);
}

#[test]
fn repeated_requests_preserve_the_payload() {
    let first = application::response_body();
    assert_eq!(first, application::response_body());
}
`);
      Object.assign(check, { runner: 'rust', cwd: nativeTests, args: [] });
    }
    checks.push(check);
  }
  if (checks.length > 32) throw new CliError('Test starters support up to 32 checks, including the frontend build.', EXIT.usage, 'too_many_test_checks');
  files.set('blinkhost.tests.json', JSON.stringify({ schema: 'blinkhost.local-test-config/v1', checks }, null, 2) + '\n');
  files.set('TESTING.md', `# Application tests

Run \`blinkhost test . --json\` before preview. Install Node 22.23.3, Python 3.12.3,
Go 1.27.3 or Rust/Cargo 1.98.0 for the languages you selected; these are the locally
qualified versions on Linux. The installed BlinkHost CLI supplies the result
adapters, so no account or application dependency on the CLI is needed.

The \`runner\` checks in \`blinkhost.tests.json\` select native unit tests explicitly.
Customize their args, directories and tests as your application grows. JavaScript
and TypeScript tests invoke the actual handler. Python/Go/Rust tests use the same
pure application logic as their guest entrypoint. Rust's separate native test
crate avoids loading the compiler-image SDK on your workstation; Go tests select
the pure application package. Python tests do not import the WASI-only host.
JavaScript, TypeScript, Python and Rust test files live under \`tests/native/\`
outside the guest module bundle. The Python runner disables bytecode writes so
native testing leaves no unsupported cache files in the guest source directory.
TypeScript uses Node's experimental type stripping; it does not typecheck.

${options.framework === 'html' ? 'Static HTML is structurally validated; no frontend test is selected.' : 'The frontend build runs separately after dependency installation; a build is not test evidence.'}
Native results do not certify host calls, compiled WASM, libSQL, browser behavior
or guest coverage. No host operation is replaced with an implicit passing mock.
Coverage remains unavailable unless a qualified adapter actually collects it;
Rust per-test timing is unavailable. Add Rust doctests as an explicit separate
\`cargo test --doc\` check; their aggregate counts remain unknown. Custom commands
and integration/browser checks can be configured separately with honest profiles.

Install frontend dependencies first when a build check is present. Module SDK
paths still refer to the pinned BlinkHost compiler images for guest builds.
Dependency/tool downloads and custom tests use your local permissions; isolate
untrusted projects. These starters never send mail, charge payments or call
BlinkHost internal identity/mail systems. Extend tests with customer-owned
provider/storage fixtures when your application needs them.
`);
}
