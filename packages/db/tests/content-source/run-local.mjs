/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only CONTENT-CONVERSATION-DRIVEN A2 (migration MIGRATION) verification. No database URL,
// environment secret or remote host is accepted.
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
if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) throw new Error('Require --local-only');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-content-source-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','a2','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const migrationPath='packages/db/migrations/0269_content_derived_source.sql';
const report={build:null,checks:[],failed:null};
let client;
try {
 ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
  '-e','POSTGRES_DB=a2','-e','POSTGRES_HOST_AUTH_METHOD=trust',POSTGRES_IMAGE]));
 let ready=false;
 for(let i=0;i<300&&!ready;i++){
  ready=docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','a2']).status===0;
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'local postgres ready');
 installPgCronStub(root,name,(argv,input)=>ok(docker(['exec',...argv],input)));
 const outcome=r=>({ok:r.status===0&&!r.error,error:r.stderr});
 report.build=buildFromFiles(root,{applyFile:path=>outcome(sql(read(path))),
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','a2','-c',input])),
  fingerprint:snapshot});
 assert.equal(report.build.failed,null);
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 client=new Client({connectionString:`postgres://postgres@${address}/a2`});await client.connect();
 const finalCatalog=snapshot();
 ok(sql(read(migrationPath)));
 assert.deepEqual(snapshot(),finalCatalog,'repeat MIGRATION preserves the complete final catalog');
 report.checks.push('MIGRATION reapplication preserves the full catalog');
 for(const fixture of ['packages/db/tests/erasure-b2a/fixture.sql','packages/db/tests/content-erasure/fixture.sql',
  'packages/db/tests/content-source/fixture.sql'])ok(sql(read(fixture)));
 const helpers=await runCases(client,report);
 await runConcurrency(client,address,helpers,report);
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
