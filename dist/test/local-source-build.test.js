import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CliError } from '../errors.js';
import { buildLocalSource } from '../local-source-build.js';
const executableDigest = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const compiler = `import fs from 'node:fs';
console.log('token=private-build-canary');
if (process.env.AWS_ACCESS_KEY_ID) throw Error('inherited credential');
const value=fs.readFileSync('input.txt','utf8');
if(value==='fail') process.exit(7);
if(value==='stall') {
  process.on('SIGTERM',()=>{});
  if (process.argv[2]) fs.writeFileSync(process.argv[2], 'ready');
  setInterval(()=>{},1000); await new Promise(()=>{});
}
if(value==='noisy') { process.stdout.write('x'.repeat(2*1024*1024)); }
if(value==='mutate-source') fs.writeFileSync('input.txt','changed');
if(value==='mutate-original') fs.writeFileSync(process.argv[2],'changed');
if(value==='mutate-config') fs.appendFileSync(process.argv[2],' ');
if(value==='symlink') fs.symlinkSync('missing-target',process.env.BLINKHOST_LOCAL_BUILD_ARTIFACT);
else fs.writeFileSync(process.env.BLINKHOST_LOCAL_BUILD_ARTIFACT,
 value==='invalid' ? Buffer.from('not wasm') : Buffer.from([0,97,115,109,1,0,0,0]));
if(process.argv[2] && value==='literal') console.log(process.argv[2]);
`;
async function fixture(t, value = 'ok') {
    const base = await mkdtemp(join(tmpdir(), 'blinkhost-source-build-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'project');
    await mkdir(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/compile.mjs'), compiler);
    await writeFile(join(root, 'src/input.txt'), value);
    const config = { schema: 'blinkhost.local-source-build/v1', source_root: 'src',
        files: ['input.txt', 'compile.mjs'], command: { path: process.execPath, sha256: executableDigest },
        args: ['compile.mjs'], artifact: 'module.wasm', timeout_ms: 5000 };
    const save = () => writeFile(join(root, 'build.json'), JSON.stringify(config));
    await save();
    return { root, directory: join(base, 'build'), config, save };
}
const code = (value) => (error) => error instanceof CliError && error.code === value;
test('explicit source snapshot produces a private artifact and an honest build receipt', async (t) => {
    const f = await fixture(t);
    const receipt = await buildLocalSource(f.root, 'build.json', f.directory);
    assert.equal(receipt.status, 'compiled');
    assert.equal(receipt.validation, 'portable_header_only');
    assert.equal(receipt.sandbox, 'customer_command_no_sandbox');
    assert.equal(receipt.production_authority, false);
    assert.deepEqual(Object.keys(receipt.source_sha256), ['compile.mjs', 'input.txt']);
    assert.equal(receipt.execution?.exit_code, 0);
    assert.ok(receipt.artifact);
    assert.equal(receipt.artifact.bytes, 8);
    assert.equal(createHash('sha256').update(await readFile(receipt.artifact.path)).digest('hex'), receipt.artifact.sha256);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'build-result.json'), 'utf8')), receipt);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(receipt.artifact.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(f.directory, 'build-result.json'))).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(receipt), /private-build-canary/);
});
test('literal compiler arguments have no shell expansion and account environment is excluded', async (t) => {
    const f = await fixture(t, 'literal');
    f.config.args.push('$(touch injected); `echo leaked`');
    await f.save();
    const old = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = 'private-aws-canary';
    try {
        const receipt = await buildLocalSource(f.root, 'build.json', f.directory);
        assert.match(receipt.execution.output.stdout, /\$\(touch injected\); `echo leaked`/);
        await assert.rejects(access(join(f.directory, 'source/injected')));
    }
    finally {
        if (old === undefined)
            delete process.env.AWS_ACCESS_KEY_ID;
        else
            process.env.AWS_ACCESS_KEY_ID = old;
    }
});
for (const [value, expected] of [['fail', 'failed'], ['stall', 'timed_out'], ['noisy', 'output_limit']]) {
    test(`a ${value} compiler retains its failure without accepting an artifact`, async (t) => {
        const f = await fixture(t, value);
        if (value === 'stall')
            f.config.timeout_ms = 100;
        await f.save();
        await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code('local_source_build_' + expected));
        const record = JSON.parse(await readFile(join(f.directory, 'build-result.json'), 'utf8'));
        assert.equal(record.status, 'rejected');
        assert.equal(record.artifact, null);
        assert.equal(record.execution.status, expected);
        await assert.rejects(access(join(f.directory, 'compiled.wasm')));
    });
}
for (const value of ['mutate-source', 'mutate-original', 'mutate-config']) {
    test(`a compiler cannot publish a stale ${value} source/configuration snapshot`, async (t) => {
        const f = await fixture(t, value);
        f.config.args.push(join(f.root, value === 'mutate-config' ? 'build.json' : 'src/input.txt'));
        await f.save();
        await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code(value === 'mutate-config' ? 'local_source_build_configuration_changed' : 'local_source_build_source_changed'));
        const record = JSON.parse(await readFile(join(f.directory, 'build-result.json'), 'utf8'));
        assert.equal(record.artifact, null);
        assert.equal(record.status, 'rejected');
    });
}
for (const [value, expected] of [['invalid', 'local_source_build_invalid_portable_header'], ['symlink', 'invalid_local_source_build_file']]) {
    test(`a ${value} output cannot be accepted by the source compiler envelope`, async (t) => {
        const f = await fixture(t, value);
        await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code(expected));
        assert.equal(JSON.parse(await readFile(join(f.directory, 'build-result.json'), 'utf8')).artifact, null);
    });
}
test('a cancelled owned build retains its terminal result', async (t) => {
    const f = await fixture(t, 'stall'), controller = new AbortController();
    f.config.args.push(join(f.root, 'compiler-ready'));
    await f.save();
    const watcher = watch(f.root, (_event, filename) => {
        if (filename === 'compiler-ready')
            controller.abort();
    });
    t.after(() => watcher.close());
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory, { signal: controller.signal }), code('local_source_build_cancelled'));
    assert.equal(JSON.parse(await readFile(join(f.directory, 'build-result.json'), 'utf8')).execution.status, 'cancelled');
});
test('a build cancelled before ownership leaves the state directory available', async (t) => {
    const f = await fixture(t);
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory, { signal: AbortSignal.abort() }), code('local_source_build_cancelled'));
    await assert.rejects(access(f.directory), { code: 'ENOENT' });
});
test('invalid configuration, source symlinks and wrong compiler digests fail before state creation', async (t) => {
    const f = await fixture(t);
    f.config.command.sha256 = '0'.repeat(64);
    await f.save();
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code('local_source_build_command_digest_mismatch'));
    f.config.command.sha256 = executableDigest;
    f.config.files = ['../input.txt'];
    await f.save();
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code('invalid_local_source_build_path'));
    f.config.files = ['input-link'];
    await symlink('input.txt', join(f.root, 'src/input-link'));
    await f.save();
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), code('invalid_local_source_build_file'));
    await assert.rejects(access(f.directory));
});
test('source build state cannot overwrite or resume a previous run', async (t) => {
    const f = await fixture(t);
    await mkdir(f.directory);
    await writeFile(join(f.directory, 'keep'), 'active');
    await assert.rejects(buildLocalSource(f.root, 'build.json', f.directory), (error) => error.code === 'EEXIST');
    assert.equal(await readFile(join(f.directory, 'keep'), 'utf8'), 'active');
});
//# sourceMappingURL=local-source-build.test.js.map