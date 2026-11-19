import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { rustTestCensus, rustTestResults } from '../local-test-rust-runner.js';
import { runLocalTestCommand, LocalTestCommandFailure } from '../local-test-command.js';
import { createScaffold } from '../templates.js';
import { writeScaffoldAtomically } from '../project.js';
import { testProject, type LocalProjectCheckResult } from '../workflows.js';

const adapter = resolve('dist/local-test-rust-runner.js');
async function fixture(t: TestContext, source: string, options: { profile?: string; args?: string[] } = {}): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(),'blinkhost-rust-runner-'));
  t.after(() => rm(parent,{ recursive:true,force:true }));
  const root = join(parent,'project');
  const scaffold = createScaffold({ name:'checks',framework:'html',packageManager:'npm',modules:[] });
  await writeScaffoldAtomically(root,scaffold.files,scaffold.manifest);
  await mkdir(join(root,'src'));
  await writeFile(join(root,'Cargo.toml'),'[package]\nname = "customer_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
  await writeFile(join(root,'src/lib.rs'),source);
  await writeFile(join(root,'blinkhost.tests.json'),JSON.stringify({ schema:'blinkhost.local-test-config/v1',checks:[{
    id:'rust-native',target:'project',command:process.execPath,args:[adapter,...(options.args ?? [])],
    kind:'test',profile:options.profile ?? 'native',results:{ format:'blinkhost/v1' },
  }] }));
  return root;
}
function failedCheck(error: unknown, code = 'project_test_failed') {
  assert.ok(error instanceof LocalTestCommandFailure);
  assert.equal(error.code,code);
  return (error.projectChecks as LocalProjectCheckResult).checks[0]!;
}

test('actual stable Rust unit and integration binaries report individual tests and ignored cases',async t => {
  const root = await fixture(t,'pub fn sum(a:u32,b:u32)->u32 { a+b }\n#[test]\nfn passes() { assert_eq!(sum(3,3),6); }\n#[test]\nfn other() {}\n#[test]\n#[ignore = "optional"]\nfn skipped() {}\n');
  await mkdir(join(root,'tests'));
  await writeFile(join(root,'tests/integration.rs'),'#[test]\nfn integrates() { assert_eq!(customer_fixture::sum(2,3),5); }\n');
  const result = await testProject([root]);
  assert.equal(result.status,'tests_passed');
  assert.deepEqual(result.test_counts,{ total:4,passed:3,failed:0,skipped:1,unsupported:0 });
  assert.equal(result.tests_executed,3);
  assert.match(result.checks[0]!.report!.runner,/^rust:libtest\/1\./);
  assert.ok(result.checks[0]!.report!.tests.every(row => row.duration_ms === undefined));
  assert.deepEqual(result.coverage,{ native:'not_collected',wasm:'not_collected' });
});

test('Rust assertion and panic failures preserve nonzero exits and per-test screened diagnostics',async t => {
  const root = await fixture(t,'#[test]\nfn fails() { panic!("password=fixture-secret Bearer fixture-auth {}",std::env::var("BLINKHOST_TEST_RUN_ID").unwrap()); }\n#[test]\nfn other_failure() { panic!("other fixture failure"); }\n#[test]\nfn passes() {}\n');
  await assert.rejects(testProject([root]),(error:unknown) => {
    const check = failedCheck(error);
    assert.equal(check.execution!.exit_code,101);
    assert.deepEqual(check.report!.counts,{ total:3,passed:1,failed:2,skipped:0,unsupported:0 });
    assert.doesNotMatch(JSON.stringify(error),/fixture-secret|fixture-auth/);
    const first = check.report!.tests.find(row => row.name.endsWith('/fails'))!;
    assert.match(first.message!,/LOCAL TEST CONTEXT/);
    assert.doesNotMatch(first.message!,/other fixture failure/);
    return true;
  });
});

test('empty and ignored-only Rust suites never claim executed tests',async t => {
  for (const [source,status,skipped] of [
    ['pub fn value()->u32 { 1 }\n','no_tests',0],
    ['#[test]\n#[ignore]\nfn skipped() {}\n','skipped',1],
  ] as const) {
    const result = await testProject([await fixture(t,source)]);
    assert.equal(result.status,status);
    assert.equal(result.tests_executed,0);
    assert.deepEqual(result.test_counts,{ total:skipped,passed:0,failed:0,skipped,unsupported:0 });
  }
});

test('Rust exact filters and explicit ignored-test selection reach stable libtest',async t => {
  const source = '#[test]\nfn passes() {}\n#[test]\n#[ignore]\nfn skipped() {}\n';
  const selected = await testProject([await fixture(t,source,{ args:['--','passes','--exact'] })]);
  assert.deepEqual(selected.test_counts,{ total:1,passed:1,failed:0,skipped:0,unsupported:0 });
  const included = await testProject([await fixture(t,source,{ args:['--','--include-ignored'] })]);
  assert.deepEqual(included.test_counts,{ total:2,passed:2,failed:0,skipped:0,unsupported:0 });
  const ignored = await testProject([await fixture(t,source,{ args:['--','--ignored'] })]);
  assert.deepEqual(ignored.test_counts,{ total:1,passed:1,failed:0,skipped:0,unsupported:0 });
});

test('Cargo positional filters select actual passing, failing and zero-match tests',async t => {
  const source = '#[test]\nfn passes() {}\n#[test]\nfn fails() { panic!("selected failure"); }\n';
  const selected = await testProject([await fixture(t,source,{ args:['passes','--','--exact'] })]);
  assert.deepEqual(selected.test_counts,{ total:1,passed:1,failed:0,skipped:0,unsupported:0 });
  assert.ok(selected.checks[0]!.report!.tests[0]!.name.endsWith('/passes'));
  await assert.rejects(testProject([await fixture(t,source,{ args:['fails','--','--exact'] })]),(error:unknown) => {
    const check = failedCheck(error);
    assert.deepEqual(check.report!.counts,{ total:1,passed:0,failed:1,skipped:0,unsupported:0 });
    assert.ok(check.report!.tests[0]!.name.endsWith('/fails'));
    return true;
  });
  const empty = await testProject([await fixture(t,source,{ args:['no_matching_test'] })]);
  assert.equal(empty.status,'no_tests');
  assert.equal(empty.tests_executed,0);
  assert.deepEqual(empty.test_counts,{ total:0,passed:0,failed:0,skipped:0,unsupported:0 });
});

test('Cargo option values and attached short options never become libtest filters',async t => {
  const root = await fixture(t,'#[test]\nfn passes() {}\n#[test]\nfn fails() { panic!("not selected"); }\n',{
    args:['--manifest-path','Cargo.toml','--features','fixture','-pcustomer_fixture','-j1',
      '--profile=dev','--lib','passes','--','--exact'],
  });
  const manifest = await readFile(join(root,'Cargo.toml'),'utf8');
  await writeFile(join(root,'Cargo.toml'),manifest+'\n[features]\nfixture = []\n');
  const selected = await testProject([root]);
  assert.deepEqual(selected.test_counts,{ total:1,passed:1,failed:0,skipped:0,unsupported:0 });
  assert.ok(selected.checks[0]!.report!.tests[0]!.name.endsWith('/passes'));
});

test('ambiguous Cargo filters and unknown option forms fail before build scripts',async t => {
  for (const args of [['passes','another_filter'],['--unknown-selection','passes'],
    ['--features'],['--features','--lib'],['--manifest-path='],['--locked=value'],['-Zunstable-options']]) {
    const root = await fixture(t,'#[test]\nfn passes() {}\n',{ args });
    await writeFile(join(root,'build.rs'),'fn main() { std::fs::write("touched",b"yes").unwrap(); }\n');
    await assert.rejects(testProject([root]));
    await assert.rejects(access(join(root,'touched')));
  }
});

test('Rust build failures cannot supply test evidence',async t => {
  await assert.rejects(testProject([await fixture(t,'#[test]\nfn broken() { missing_fixture(); }\n')]),(error:unknown) => {
    const check = failedCheck(error);
    assert.notEqual(check.execution!.exit_code,0);
    assert.equal(check.report,undefined);
    return true;
  });
});

test('Rust profiles and unsupported modes fail before Cargo executes customer build scripts',async t => {
  for (const options of [{ profile:'wasm' },{ profile:'browser' },{ args:['--doc'] },{ args:['--target=wasm32-wasip1'] },
    { args:['--','--nocapture'] },{ args:['--','--format=json'] },{ args:['--','-Z','unstable-options'] }]) {
    const root = await fixture(t,'#[test]\nfn passes() {}\n',options);
    await writeFile(join(root,'build.rs'),'fn main() { std::fs::write("touched",b"yes").unwrap(); }\n');
    await assert.rejects(testProject([root]));
    await assert.rejects(access(join(root,'touched')));
  }
});

test('Rust reporter requires native run context and cannot overwrite existing evidence',async t => {
  const root = await fixture(t,'#[test]\nfn passes() {}\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BLINKHOST_TEST_')) delete env[key];
  const missing = await runLocalTestCommand(process.execPath,[adapter],{ cwd:root,env });
  assert.equal(missing.exit_code,2);
  const path = join(root,'existing.json');
  await writeFile(path,'preserved');
  const existing = await runLocalTestCommand(process.execPath,[adapter],{ cwd:root,env:{ ...env,
    BLINKHOST_TEST_RESULT_PATH:path,BLINKHOST_TEST_RUN_ID:randomUUID(),BLINKHOST_TEST_CHECK_ID:'rust-native',BLINKHOST_TEST_PROFILE:'native' } });
  assert.equal(existing.exit_code,2);
  assert.equal(await readFile(path,'utf8'),'preserved');
});

test('Rust check timeout and output limits terminate actual Cargo or libtest processes',async t => {
  const slow = await fixture(t,'#[test]\nfn slow() { std::thread::sleep(std::time::Duration::from_secs(10)); }\n');
  await assert.rejects(testProject([slow,'--timeout','1']),(error:unknown) => {
    assert.equal(failedCheck(error,'project_test_timeout').status,'timed_out');
    return true;
  });
  const noisy = await fixture(t,'#[test]\nfn noisy() { println!("{}","x".repeat(100000)); panic!("fixture failure"); }\n');
  await assert.rejects(testProject([noisy,'--max-output-bytes','4096']),(error:unknown) => {
    assert.equal(failedCheck(error,'project_test_output_limit').status,'output_limit');
    return true;
  });
});

test('Rust cancellation and abnormal binary exit cannot certify unfinished tests',async t => {
  const exited = await fixture(t,'#[test]\nfn exits() { std::process::exit(7); }\n');
  await assert.rejects(testProject([exited]),(error:unknown) => {
    assert.equal(failedCheck(error).report,undefined);
    return true;
  });
  const root = await fixture(t,'#[test]\nfn slow() { std::thread::sleep(std::time::Duration::from_secs(10)); }\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('SIGINT'),300);
  try {
    await assert.rejects(testProject([root],false,controller.signal),(error:unknown) => {
      assert.equal(failedCheck(error,'project_test_cancelled').status,'cancelled');
      return true;
    });
  } finally { clearTimeout(timer); }
});

const ctx = { path:'/tmp/result.json',runId:'fixture-run',checkId:'rust-native' };
test('Rust stable census and summary reconciliation reject incomplete or contradictory output',() => {
  for (const output of ['test_one: benchmark\n','test_one: test\ntest_one: test\n','unexpected header\n']) assert.throws(() => rustTestCensus(output));
  assert.throws(() => rustTestCensus(Array.from({ length:10001 },(_,i) => `test_${i}: test`).join('\n')));
  const summary = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
  for (const output of [summary,'test other ... ok\n'+summary,'test one ... ok\ntest one ... ok\n'+summary,
    'test one ... FAILED\n'+summary,'test one ... ok\n'+summary+summary]) {
    assert.throws(() => rustTestResults(output,['one'],new Set(),0,ctx));
  }
  assert.throws(() => rustTestResults('test one ... ok\n'+summary,['one'],new Set(['one']),0,ctx));
});

test('Rust per-test diagnostics screen credentials and UTF-8 boundaries before truncation',() => {
  const output = 'test one ... FAILED\nfailures:\n\n---- one stdout ----\n\u001b[31m'+'é'.repeat(2040)
    +' token=boundary-secret Bearer fixture-auth fixture-run\n\nfailures:\n    one\n\n'
    +'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
  const rows = rustTestResults(output,['one'],new Set(),101,ctx);
  assert.doesNotMatch(JSON.stringify(rows),/boundary-secret|fixture-auth|fixture-run|\u001b|�/);
  assert.ok(Buffer.byteLength(rows[0]!.message!) <= 4096);
  assert.equal(rows[0]!.status,'failed');
});

test('Rust successful reports are private and never invent individual timing or coverage',async t => {
  const root = await fixture(t,'#[test]\nfn passes() {}\n');
  const path = join(root,'fresh.json');
  const run = await runLocalTestCommand(process.execPath,[adapter],{ cwd:root,env:{ ...process.env,
    BLINKHOST_TEST_RESULT_PATH:path,BLINKHOST_TEST_RUN_ID:randomUUID(),BLINKHOST_TEST_CHECK_ID:'rust-native',BLINKHOST_TEST_PROFILE:'native' } });
  assert.equal(run.exit_code,0);
  const report = JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(report.coverage,{ status:'not_collected' });
  assert.equal(report.tests[0].duration_ms,undefined);
  assert.equal((await stat(path)).mode & 0o777,0o600);
});

test('Rust doctests run as an explicit separate check with unknown aggregate counts',async t => {
  const root = await fixture(t,'/// ```\n/// assert_eq!(customer_fixture::sum(2,3),5);\n/// ```\npub fn sum(a:u32,b:u32)->u32 { a+b }\n#[test]\nfn passes() { assert_eq!(sum(1,2),3); }\n');
  const config = JSON.parse(await readFile(join(root,'blinkhost.tests.json'),'utf8'));
  config.checks.push({ id:'rust-doc',target:'project',command:'cargo',args:['test','--doc'],kind:'test',profile:'native' });
  await writeFile(join(root,'blinkhost.tests.json'),JSON.stringify(config));
  const result = await testProject([root]);
  assert.equal(result.checks.length,2);
  assert.ok(result.checks.every(check => check.status === 'succeeded'));
  assert.equal(result.checks[0]!.report!.counts.total,1);
  assert.equal(result.checks[1]!.report,undefined);
  assert.equal(result.test_evidence,'mixed');
  assert.equal(result.tests_executed,null);
  assert.equal(result.test_counts,undefined);
});
