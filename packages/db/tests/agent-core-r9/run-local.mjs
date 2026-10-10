/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only R9 migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases as runDeletionRegression} from '../content-erasure/cases.mjs';
import {runArtifacts} from '../content-erasure/artifacts.mjs';
import {runCaptureV3} from '../content-erasure/capture-v3.mjs';
import {runVideo} from '../content-erasure/video.mjs';
import {runProducers} from '../content-erasure/producers.mjs';
import {runStrategy} from '../content-erasure/strategy.mjs';
import {runSettings} from '../content-erasure/settings.mjs';
import {runResearch} from '../content-erasure/research.mjs';
import {runDependencies} from '../content-erasure/dependencies.mjs';
import {runPayg} from '../content-erasure/payg.mjs';
import {runCases} from './cases.mjs';
import {runProvenance} from './provenance.mjs';
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
const image=POSTGRES_IMAGE.replace(/:[^/@]+@/, '@'); // Same pinned digest; match the account-erasure runner.
ok(docker(['image','inspect',image]));
const name=`graylum-agent-core-r9-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0208_agent_core_data_foundation.sql';
const migration=read(migrationPath);
const report={development,build:null,checks:[],failed:null};
let client;let seeded=false;
try {
 ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
  '-e','POSTGRES_DB=b2a','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]));
 let ready=false;
 for(let i=0;i<300&&!ready;i++){
  ready=docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','b2a']).status===0;
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'local postgres ready');
 installPgCronStub(root,name,(argv,input)=>ok(docker(['exec',...argv],input)));
 const outcome=r=>({ok:r.status===0&&!r.error,error:r.stderr});
 report.build=buildFromFiles(root,{applyFile:path=>{
   if(path===migrationPath&&!seeded){
    ok(sql(read('packages/db/tests/erasure-b2a/fixture.sql')));
    ok(sql(read('packages/db/tests/content-erasure/fixture.sql')));
    ok(sql(`CREATE SCHEMA r9_test;
     CREATE TABLE r9_test.legacy AS SELECT d7_test.artifacts((b2a_test.fixture()->>'actor')::uuid) f;`));
    seeded=true;
   }
   return outcome(sql(read(path)));
  },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 const finalCatalog=snapshot();
 ok(sql(migration));
 assert.deepEqual(snapshot(),finalCatalog,'repeat 0208 preserves the complete final catalog');
 report.checks.push('0208 reapplication with all later migrations preserves full catalog');
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 const legacy=(await client.query('SELECT f FROM r9_test.legacy')).rows[0].f;
 assert.equal((await client.query('SELECT created_at FROM opc_drafts WHERE project_id=$1',[legacy.project])).rows[0].created_at,null);
 report.checks.push('pre-migration creation time stays unknown; no fabricated migration timestamp');
 await runCases(client,report);
 await client.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 await runProvenance(client,report);
 await runProvenance(client,report,'agent_proposal');
 await runConcurrency({db:client,Client,connectionString,report});
 // Reuse D7 behavior coverage without reapplying its historical migration over R9.
 await runDeletionRegression(client,report);
 await runArtifacts(client,report);
 await runCaptureV3(client,report);
 await runVideo(client,report);
 await runProducers(client,report);
 await runStrategy(client,report);
 await runSettings({db:client,Client,connectionString,report});
 await runResearch({db:client,Client,connectionString,report});
 await runDependencies(client,report);
 await runPayg(client,report);
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
