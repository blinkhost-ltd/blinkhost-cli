import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkLocalHtml, localAudit, runSeo } from '../seo.js';
import { ApiClient } from '../api.js';
import { EXIT } from '../errors.js';
const good = '<title>Docs</title><meta name="description" content="Useful docs"><link rel="canonical" href="https://example.com/docs">';
test('local findings use stable keys and explicitly untrusted evidence', () => {
  assert.deepEqual(checkLocalHtml(good, '/docs', 'docs.html'), []);
  const a=checkLocalHtml('', '/docs', 'docs.html'), b=checkLocalHtml('<h1>Updated</h1>', '/docs', 'docs.html');
  assert.deepEqual(a.map(f=>f.key), b.map(f=>f.key));
  assert.ok(a.every(f=>f.content_is_untrusted && f.key.length===64));
});
test('local audit excludes reordered noindex, private, hidden paths and symlinks; empty coverage fails closed', async () => {
  const dir=await mkdtemp(join(tmpdir(),'seo-test-'));
  try {
    await writeFile(join(dir,'index.html'),'<meta content="NOINDEX,follow" name = "robots">');
    await writeFile(join(dir,'private.html'),'<meta content=private name="blinkhost:visibility">');
    await mkdir(join(dir,'.hidden')); await writeFile(join(dir,'.hidden','index.html'),'');
    await symlink(join(dir,'.hidden'),join(dir,'linked'));
    const skipped=await localAudit(dir,true);
    assert.equal((skipped.coverage as {files:number}).files,0);
    assert.equal((skipped.gate as {passed:boolean}).passed,false);
    await writeFile(join(dir,'docs.html'),good);
    const result=await localAudit(dir,true);
    assert.equal((result.coverage as {files:number}).files,1);
    assert.equal((result.gate as {passed:boolean}).passed,true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('hosted argument validation happens before auth or network', async () => {
  const original=ApiClient.create; let calls=0;
  ApiClient.create=async()=>{calls++; throw new Error('unexpected auth');};
  try {
    for (const args of [['audit','-'.repeat(36)], ['audit','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','--pages','0'], ['remediate','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']]) {
      await assert.rejects(runSeo(args), error=>error instanceof Error && error.message!=='unexpected auth');
    }
    assert.equal(calls,0);
  } finally { ApiClient.create=original; }
});
test('hosted tasks retain bounds, selected model and idempotency', async () => {
  const original=ApiClient.create, calls: {path:string; body:Record<string,unknown>}[]=[];
  ApiClient.create=async()=>({request:async(path:string,options:{body:string})=>{calls.push({path,body:JSON.parse(options.body)}); return {status:'queued'};}} as unknown as ApiClient);
  const project='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', audit='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    await runSeo(['audit',project,'--pages','5','--browser-pages','1','--gate','--changed','--baseline',audit]);
    assert.equal(calls[0]!.body.page_limit,5); assert.equal(calls[0]!.body.gate,true);
    assert.equal(calls[0]!.body.scope,'changed'); assert.equal(calls[0]!.body.baseline_id,audit);
    assert.match(String(calls[0]!.body.client_request_id),/^[a-f0-9-]{36}$/);
    await runSeo(['remediate',project,audit,'--model','customer-model','--max-units','12','--findings','a'.repeat(64)]);
    assert.equal(calls[1]!.body.model,'customer-model'); assert.equal(calls[1]!.body.maximum_units,12);
  } finally {ApiClient.create=original;}
});
test('CLI help and local gates work through the distributable entry point', async () => {
  const cli=join(process.cwd(),'dist','cli.js');
  const help=spawnSync(process.execPath,[cli,'seo','--help','--json'],{encoding:'utf8'});
  assert.equal(help.status,EXIT.success);
  assert.equal(help.stderr,'');
  assert.equal(JSON.parse(help.stdout).data.topic.name,'seo');
  const dir=await mkdtemp(join(tmpdir(),'seo-cli-gate-'));
  try {
    for (const [html,exit] of [['',EXIT.validation],[good,EXIT.success]] as const) {
      await writeFile(join(dir,'index.html'),html);
      const result=spawnSync(process.execPath,[cli,'seo','local',dir,'--gate','--json'],{encoding:'utf8'});
      assert.equal(result.status,exit);
      assert.equal(result.stderr,'');
      const payload=JSON.parse(result.stdout);
      assert.equal(payload.data.coverage.files,1);
      assert.equal(payload.data.gate.passed,exit===EXIT.success);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
