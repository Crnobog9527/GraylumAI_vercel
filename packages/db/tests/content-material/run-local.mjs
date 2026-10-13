/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only CONTENT-CONVERSATION-DRIVEN A1 (migration 0229) verification. No database URL,
// environment secret or remote host is accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runVideo} from '../content-erasure/video.mjs';
import {runCases} from './cases.mjs';
if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) throw new Error('Require --local-only');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
const image=POSTGRES_IMAGE.replace(/:[^/@]+@/, '@');
ok(docker(['image','inspect',image]));
const name=`graylum-content-material-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','a1','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0229_content_material_projection.sql';
const report={build:null,checks:[],failed:null};
let client;let seeded=false;
try {
 ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
  '-e','POSTGRES_DB=a1','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]));
 let ready=false;
 for(let i=0;i<300&&!ready;i++){
  ready=docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','a1']).status===0;
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'local postgres ready');
 installPgCronStub(root,name,(argv,input)=>ok(docker(['exec',...argv],input)));
 const outcome=r=>({ok:r.status===0&&!r.error,error:r.stderr});
 report.build=buildFromFiles(root,{applyFile:path=>{
   if(path===migrationPath&&!seeded){
    // Pre-A1 state: content saves wrote full bodies into the latest scope material.
    ok(sql(read('packages/db/tests/erasure-b2a/fixture.sql')));
    ok(sql(read('packages/db/tests/content-erasure/fixture.sql')));
    ok(sql(read('packages/db/tests/content-material/legacy.sql')));
    seeded=true;
   }
   return outcome(sql(read(path)));
  },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','a1','-c',input])),
  fingerprint:snapshot});
 assert.equal(report.build.failed,null);
 assert.ok(seeded,'legacy rows seeded before 0229');
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 client=new Client({connectionString:`postgres://postgres@${address}/a1`});await client.connect();
 const revisions=async()=>(await client.query('SELECT count(*)::int n FROM runtime_scope_material')).rows[0].n;
 const finalCatalog=snapshot(),finalRevisions=await revisions();
 ok(sql(read(migrationPath)));
 assert.deepEqual(snapshot(),finalCatalog,'repeat 0229 preserves the complete final catalog');
 assert.equal(await revisions(),finalRevisions,'repeat 0229 appends no further material');
 report.checks.push('0229 reapplication preserves the full catalog and appends no material');
 await runCases(client,report);
 await client.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 await runVideo(client,report);
 report.checks.push('D7 video-binding erasure regression still passes on 0229');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
