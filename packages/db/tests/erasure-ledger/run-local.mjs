/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only B2b migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
import {runConcurrency} from './concurrency.mjs';
const development=process.argv.slice(2).join(' ')==='--local-only --development';
if ((!development && process.argv.slice(2).join(' ') !== '--local-only') || process.env.CI) throw new Error('Require --local-only');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-erasure-ledger-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0188_erasure_ledger_content.sql';
const migration=read(migrationPath);
const report={development,build:null,checks:[],failed:null};
let client;
try {
 ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
  '-e','POSTGRES_DB=b2a','-e','POSTGRES_HOST_AUTH_METHOD=trust',POSTGRES_IMAGE]));
 let ready=false;
 for(let i=0;i<300&&!ready;i++){
  ready=docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','b2a']).status===0;
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'local postgres ready');
 installPgCronStub(root,name,(argv,input)=>ok(docker(['exec',...argv],input)));
 const outcome=r=>({ok:r.status===0&&!r.error,error:r.stderr});
 let historicalChecked=false;
 report.build=buildFromFiles(root,{applyFile:path=>{
  if(path!==migrationPath||historicalChecked)return outcome(sql(read(path)));
  const before=snapshot();
  const applied=sql(read(path));
  if(applied.status!==0||applied.error)return outcome(applied);
  const once=snapshot();
  ok(sql(read('packages/db/tests/erasure-ledger/rollback.sql')));
  assert.deepEqual(snapshot(),before,'historical empty rollback restores pre-migration catalog');
  ok(sql(migration));
  assert.deepEqual(snapshot(),once);
  historicalChecked=true;
  report.checks.push('0188 historical empty rollback/reapply exact');
  return outcome(applied);
 },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 assert.ok(historicalChecked,'0188 must be verified through the canonical build plan');
 const finalCatalog=snapshot();
 ok(sql(migration));
 assert.deepEqual(snapshot(),finalCatalog,'repeat 0188 preserves the complete final catalog');
 report.checks.push('0188 reapplication with all later migrations preserves full catalog');
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 await client.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await runCases(client,report);
 await runConcurrency({db:client,Client,connectionString,report});
 const unsafeRollback=sql(read('packages/db/tests/erasure-ledger/rollback.sql'));
 assert.notEqual(unsafeRollback.status,0);assert.match(unsafeRollback.stderr,/ERASURE_LEDGER_ROLLBACK_REQUIRES_FORWARD_FIX/);
 report.checks.push('rollback refuses after financial projection; no erased content restoration');
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
