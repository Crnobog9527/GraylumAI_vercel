/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only: re-applies the payment migrations 0308, 0310 and 0335 on the final catalog (each together with every later
// migration, tail-replay.mjs) and proves the complete catalog comes out unchanged. 0298 is not replayable on the final
// catalog: it patches function text that later migrations rewrote, so it must refuse and leave the catalog untouched.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {replayTail} from '../content-erasure/tail-replay.mjs';
if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) throw new Error('Require --local-only');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:600000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-pay-replay-${randomUUID().slice(0,8)}`;
const psql=(db,input)=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const report={checks:[],skipped:[]};
try {
 ok(docker(['run','-d','--pull=never','--name',name,'-e','POSTGRES_DB=b2a','-e','POSTGRES_HOST_AUTH_METHOD=trust',POSTGRES_IMAGE]));
 let ready=false;
 for(let i=0;i<300&&!ready;i++){
  ready=docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','b2a']).status===0;
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'local postgres ready');
 installPgCronStub(root,name,(argv,input)=>ok(docker(['exec',...argv],input)));
 const outcome=r=>({ok:r.status===0&&!r.error,error:r.stderr});
 const built=buildFromFiles(root,{applyFile:path=>outcome(psql('b2a',read(path))),
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input]))});
 assert.equal(built.failed,null);
 const finalCatalog=JSON.parse(ok(psql('b2a',objectSql)));
 // One copy of the final database per case, so a failed replay never contaminates the next.
 const copy=tag=>{const db='t_'+tag;
  ok(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','postgres','-c',`CREATE DATABASE ${db} TEMPLATE b2a`]));
  const sql=input=>psql(db,input);return {sql,snapshot:()=>JSON.parse(ok(sql(objectSql)))};};
 for(const file of ['0308_pay_dispute_guard','0310_pay_dispute_wallet_refund_serialization','0335_pay_failover']){
  const migrationPath=`packages/db/migrations/${file}.sql`;
  const {sql,snapshot}=copy(file.slice(0,4));
  await replayTail({root,read,sql,ok,snapshot,finalCatalog,report,migrationPath,first:read(migrationPath)});
  report.checks.push(`${file.slice(0,4)} reapplication with all later migrations preserves full catalog`);
 }
 const {sql,snapshot}=copy('0298');
 const refused=sql(read('packages/db/migrations/0298_pay_wallet_membership_refund.sql'));
 assert.notEqual(refused.status,0,'0298 refuses on the final catalog');
 assert.match(refused.stderr,/PAY_WALLET_REFUND_PATCH_MISSING/);
 assert.deepEqual(snapshot(),finalCatalog,'refused 0298 leaves the catalog unchanged');
 report.checks.push('0298 refuses on the final catalog (anchors rewritten by later migrations) and changes nothing');
 console.log(JSON.stringify(report,null,1));
} finally {
 docker(['rm','-f','-v',name]);
}
