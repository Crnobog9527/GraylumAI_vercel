/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only B2a migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {cases} from '../erasure-b2a/cases.mjs';
import {inflightCases} from './cases.mjs';
import {batchCases,inflightConcurrency} from './batch-cases.mjs';
import {edges} from '../erasure-b2a/edges.mjs';
import {concurrency} from '../erasure-b2a/concurrency.mjs';
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
const name=`graylum-inflight-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0160_erasure_inflight_recovery.sql';
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
 const originals=JSON.parse(read('packages/db/tests/erasure-inflight/source-md5.json'));
 let before;
 report.build=buildFromFiles(root,{applyFile:path=>{
  if(path===migrationPath&&!before){
   for(const [sig,md5]of Object.entries(originals))assert.equal(ok(sql(`SELECT md5(pg_get_functiondef('${sig}'::regprocedure));`)),md5,sig);
   report.checks.push('Q1 source md5 before 0160: 5/5');
   before=snapshot();
  }
  return outcome(sql(read(path)));
 },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 assert.ok(before,'0160 must be applied through the canonical build plan');
 const once=snapshot();
 ok(sql(migration));assert.deepEqual(snapshot(),once,'repeat 0160 is a structural no-op');
 report.checks.push('0160 canonical application/replay: identical full catalog');
 // Source drift must abort before helpers, columns or any function are changed.
 ok(sql("CREATE OR REPLACE FUNCTION bill2_read(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql "
  +"SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'; END $$;"));
 const drift=snapshot();const refused=sql(migration);
 assert.notEqual(refused.status,0);assert.match(refused.stderr,/ERASURE_INFLIGHT_SOURCE_MISMATCH/);
 assert.deepEqual(snapshot(),drift,'source drift leaves catalog untouched');
 ok(sql(read('packages/db/tests/erasure-inflight/rollback.sql')));
 assert.deepEqual(snapshot(),before,'no-data structural rollback restores exact catalog');
 ok(sql(migration));assert.deepEqual(snapshot(),once);
 report.checks.push('source drift rejects atomically; no-data rollback and reapply exact');
 const md5=value=>createHash('md5').update(value??'<null>').digest('hex').slice(0,12);
 const changes=Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(once)])]
  .filter(k=>before[k]!==once[k]).sort().map(k=>[k,{before:k in before?md5(before[k]):null,after:k in once?md5(once[k]):null}]));
 writeFileSync(resolve(root,'packages/db/tests/erasure-inflight/local-catalog-delta.json'),JSON.stringify(changes,null,2)+'\n');
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 await client.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await cases(client,report);
 await inflightCases(client,report);
 await batchCases(client,report);
 await edges(client,report);
 await concurrency({client,Client,connectionString,report});
 await inflightConcurrency({client,Client,connectionString,report});
 const unsafeRollback=sql(read('packages/db/tests/erasure-inflight/rollback.sql'));
 assert.notEqual(unsafeRollback.status,0);assert.match(unsafeRollback.stderr,/ERASURE_INFLIGHT_ROLLBACK_REQUIRES_FORWARD_FIX/);
 report.checks.push('rollback refuses after financial projection; no erased content restoration');
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
