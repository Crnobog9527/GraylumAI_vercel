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
const ci=process.argv.slice(2).join(' ')==='--ci'; // MAINT-P1: --ci (CI only) runs the default mode
if ((!development && !ci && process.argv.slice(2).join(' ') !== '--local-only') || Boolean(process.env.CI)!==ci) throw new Error('Require --local-only, or --ci in CI');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-erasure-run-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0183_erasure_run_content.sql';
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
 // MAINT-P1b: the 0183 structural checks run at 0183's place in the chain. Later migrations redefine the
 // bill2 erasure functions, so replaying 0183 or its rollback on the finished database no longer means anything.
 let before,once;
 report.build=buildFromFiles(root,{applyFile:path=>{
  if(path!==migrationPath||before)return outcome(sql(read(path)));
  before=snapshot();
  const applied=outcome(sql(migration));
  if(!applied.ok)return applied;
  once=snapshot();
  ok(sql(migration));assert.deepEqual(snapshot(),once,'repeat 0183 is a structural no-op');
  report.checks.push('0183 canonical application/replay: identical full catalog');
  ok(sql(read('packages/db/tests/erasure-run/rollback.sql')));
  assert.deepEqual(snapshot(),before,'empty structural rollback restores pre-migration catalog');
  ok(sql(migration));assert.deepEqual(snapshot(),once);
  report.checks.push('empty rollback/reapply exact');
  return applied;
 },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 assert.ok(once,'0183 must be applied through the canonical build plan');
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 await client.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await runCases(client,report);
 await runConcurrency({db:client,Client,connectionString,report});
 const unsafeRollback=sql(read('packages/db/tests/erasure-run/rollback.sql'));
 assert.notEqual(unsafeRollback.status,0);assert.match(unsafeRollback.stderr,/ERASURE_RUN_ROLLBACK_REQUIRES_FORWARD_FIX/);
 report.checks.push('rollback refuses after financial projection; no erased content restoration');
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
