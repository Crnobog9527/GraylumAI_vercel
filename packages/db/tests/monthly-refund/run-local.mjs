/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only B2b migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
import {runService} from './service-cases.mjs';
import {runConcurrency} from './concurrency.mjs';
import {seedUpgrade,verifyUpgrade} from '../pay-erasure-integration/upgrade.mjs';
import {runCombined} from '../pay-erasure-integration/combined.mjs';

const args=process.argv.slice(2).join(' ');
const modes=['--local-only','--local-only --development','--local-only --from-0186','--local-only --from-0186 --development'];
if(!modes.includes(args)||process.env.CI)throw new Error('Require explicit local-only mode');
const integrated=args.includes('--from-0186');
const development=args.endsWith('--development');
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
const name=`graylum-monthly-refund-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const report={development,integrated,build:null,checks:[],failed:null};
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
 let before;let rolled=false;let seeded;
 const additions=['0193_monthly_refund_transactions.sql','0194_monthly_refund_recovery.sql','0195_monthly_refund_shared_guards.sql'];
 report.build=buildFromFiles(root,{applyFile:path=>{
  if(path.endsWith('/'+additions[0])&&!before)before=snapshot();
  const applied=sql(read(path));
  if(integrated&&applied.status===0&&path.includes('/0186_')&&!seeded){
   seeded=seedUpgrade({sql:input=>ok(sql(input)),read,snapshot,report});
  }
  if(!integrated&&applied.status===0&&path.endsWith('/'+additions.at(-1))&&!rolled){
   const once=snapshot();ok(sql(read('packages/db/tests/monthly-refund/rollback.sql')));
   assert.deepEqual(snapshot(),before,'empty monthly rollback restores inherited deletion stack');
   for(const name of additions)ok(sql(read('packages/db/migrations/'+name)));
   assert.deepEqual(snapshot(),once,'reapply restores exact monthly catalog');rolled=true;
   report.checks.push('0193–0195 historical empty-fact rollback and reapply exact');
  }
  return outcome(applied);
 },
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 if(integrated){
  assert.ok(seeded,'0186 seed reached');
  await verifyUpgrade({db:client,before:seeded,sql:input=>ok(sql(input)),snapshot,
   built:JSON.parse(read('packages/db/tests/baseline/built-fingerprint.json')),report});
 }else await client.query(read('packages/db/tests/monthly-refund/fixture.sql'));
 await runCases({db:client,Client,connectionString,report});
 await runConcurrency({db:client,Client,connectionString,report});
 const ts=require('typescript');compiled=mkdtempSync(resolve(root,'packages/api/.monthly-refund-test-'));
 const visited=new Set();
 function compile(source){
  const dest=resolve(compiled,relative(resolve(root,'packages/api/src'),source)).replace(/\.ts$/,'.mjs');
  if(visited.has(source))return dest;visited.add(source);
  if(source===resolve(root,'packages/api/src/services/stripe.ts')){
   mkdirSync(dirname(dest),{recursive:true});
   writeFileSync(dest,"export function getStripeClient(){throw new Error('REAL_STRIPE_FORBIDDEN_IN_LOCAL_TEST')}");
   return dest;
  }
  let code=ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  code=code.replace(/from ['"](\.[^'"]+)['"]/g,(match,specifier)=>{
   const child=compile(resolve(dirname(source),specifier+'.ts'));
   let name=relative(dirname(dest),child);if(!name.startsWith('.'))name='./'+name;
   return 'from '+JSON.stringify(name);
  });
  mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,code);return dest;
 }
 const service=await import(pathToFileURL(compile(resolve(root,'packages/api/src/services/payments/monthlyRefundService.ts'))).href);
 const webhook=await import(pathToFileURL(compile(resolve(root,'packages/api/src/services/payments/monthlyRefundWebhook.ts'))).href);
 await runService({db:client,service,webhook,report});
 if(integrated){
  const module=async name=>import(pathToFileURL(compile(resolve(root,'packages/api/src/services/accountErasure/'+name+'.ts'))).href);
  await runCombined({db:client,service,webhook,report,require,ts,run,root,
   ...(await module('processor')),...(await module('storage')),...(await module('storageTransport')),...(await module('authAdapter'))});
 }
 const unsafe=sql(read('packages/db/tests/monthly-refund/rollback.sql'));
 assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/PAY_MONTHLY_ROLLBACK_REQUIRES_FORWARD_FIX/);
 report.checks.push('any original approval blocks rollback; forward recovery required');
} catch(error) {report.failed=String(error.stack??error);report.detail=error.detail;report.where=error.where;process.exitCode=1;}
finally {
 await client?.end();if(compiled)rmSync(compiled,{recursive:true});report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
