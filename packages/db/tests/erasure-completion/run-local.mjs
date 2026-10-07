/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only B2b migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
import {runProcessor} from './processor.mjs';
import {runLeaves} from './leaves.mjs';
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
const image=POSTGRES_IMAGE.replace(/:[^/@]+@/, '@'); // Exact same pinned digest; Docker redundant-tag lookup workaround.
ok(docker(['image','inspect',image]));
const name=`graylum-erasure-completion-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const report={development,build:null,checks:[],failed:null};
let client;let compiled;
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
 let before;let checked=false;let beforeLeaves;let checkedLeaves=false;
 report.build=buildFromFiles(root,{applyFile:path=>{
  if(path.endsWith('/0190_erasure_upload_drain.sql')&&!before)before=snapshot();
  if(path.endsWith('/0192_erasure_business_leaves.sql')&&!beforeLeaves)beforeLeaves=snapshot();
  const result=sql(read(path));
  if(result.status===0&&path.endsWith('/0192_erasure_business_leaves.sql')&&!checkedLeaves){
   const once=snapshot();ok(sql(read('packages/db/tests/erasure-completion/rollback-leaves.sql')));
   assert.deepEqual(snapshot(),beforeLeaves,'empty leaves rollback exact');ok(sql(read(path)));
   assert.deepEqual(snapshot(),once,'leaves reapply exact');checkedLeaves=true;
   report.checks.push('0192 historical empty rollback/reapply exact');
  }
  if(result.status===0&&path.endsWith('/0191_erasure_completion_proof.sql')&&!checked){
   const once=snapshot();ok(sql(read('packages/db/tests/erasure-completion/rollback.sql')));
   assert.deepEqual(snapshot(),before,'empty-fact rollback restores exact pre-0190 catalog');
   ok(sql(read('packages/db/migrations/0190_erasure_upload_drain.sql')));
   ok(sql(read(path)));assert.deepEqual(snapshot(),once,'reapply restores 0191 catalog');
   checked=true;report.checks.push('0190/0191 historical empty rollback/reapply exact');
  }
  return outcome(result);
 },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 await client.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await client.query(read('packages/db/tests/package-refund/fixture.sql'));
 await runCases(client,report);
 await runLeaves(client,report);
 await runConcurrency({db:client,Client,connectionString,report});
 // Execute the actual TS coordinator; only its external Auth/Storage adapters are mocks.
 const ts=require('typescript');
 compiled=mkdtempSync(resolve(root,'packages/api/.erasure-processor-test-'));
 for(const file of ['processorContracts','processor']){
  const source=read(`packages/api/src/services/accountErasure/${file}.ts`);
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
   .replace("'./processorContracts'","'./processorContracts.mjs'");
  writeFileSync(resolve(compiled,file+'.mjs'),code);
 }
 const {processAccountErasure}=await import(pathToFileURL(resolve(compiled,'processor.mjs')).href);
 await runProcessor(client,processAccountErasure,report);
 const unsafe=sql(read('packages/db/tests/erasure-completion/rollback.sql'));
 assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/ERASURE_COMPLETION_ROLLBACK_REQUIRES_FORWARD_FIX/);
 report.checks.push('cleanup/progress facts require forward repair; rollback refused');
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();if(compiled)rmSync(compiled,{recursive:true});report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
