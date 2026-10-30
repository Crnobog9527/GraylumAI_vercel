/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only R14 migration verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
import {runFusionReview} from './fusion-review.mjs';
import {runFusionBackground} from './fusion-background.mjs';
import {runFusionFee} from './fusion-fee.mjs';
import {runFusionPausedEnd} from './fusion-paused-end.mjs';
import {runReportFee} from './report-fee.mjs';
const mode=process.argv.slice(2).join(' ');
const development=mode==='--local-only --development';
// --ci is for the CI runner (CI set, images already pulled by the workflow); --local-only never runs inside CI.
if (mode==='--ci' ? !process.env.CI : (!development && mode !== '--local-only') || process.env.CI) throw new Error('Require --local-only outside CI, or --ci inside CI');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(cmd,args,input)=>spawnSync(cmd,args,{input,encoding:'utf8',cwd:root,
 env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=r=>{if(r.status!==0||r.error)throw new Error((r.stderr||String(r.error)).slice(-5000));return r.stdout.trim();};
const endpoint=ok(run('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///')&&!endpoint.includes('\n'),'only local Docker socket');
const docker=(args,input)=>run('docker',['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-report-revision-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
// 0223 (R14), 0294 (Fusion fixed price) and 0295 (report fixed price) are each re-applied twice after the full build;
// 0319 patches 0294's settlement, so it is re-applied after it (a bare 0294 replay would put the old settlement back).
const migrations=['packages/db/migrations/0223_report_revision_sync.sql','packages/db/migrations/0294_fusion_fixed_price.sql','packages/db/migrations/0295_report_fixed_price.sql',
  'packages/db/migrations/0319_fusion_provider_refusal_verdict.sql',
  'packages/db/migrations/0334_runtime_interrupted_recovery.sql',
  // 0383 patches 0294's review check and 0295's report hold (ARCH-FIX E1 shared quarantine check).
  'packages/db/migrations/0383_credit_grant_quarantine.sql',
  'packages/db/migrations/0397_report_fee_terminal_settlement.sql',
  'packages/db/migrations/0412_report_stop_limit.sql',
  // V2-7a: report_fee_hold and report_stop as they stand with the turn path (both replayed above in their older text).
  'packages/db/migrations/0429_core_path_v2_report.sql'];
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
 report.build=buildFromFiles(root,{applyFile:path=>outcome(sql(read(path))),
  applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','b2a','-c',input])),
  fingerprint:development?undefined:snapshot});
 assert.equal(report.build.failed,null);
 for(const path of migrations){
  const migration=read(path);
  ok(sql(migration));
  const finalCatalog=snapshot();
  ok(sql(migration));
  assert.deepEqual(snapshot(),finalCatalog,`repeat ${path} preserves complete catalog`);
  report.checks.push(`${path.split('/').pop()} applied twice after current staging; complete catalog unchanged`);
 }
 const require=createRequire(resolve(root,'packages/api/package.json'));
 const {Client}=require('pg');
 const address=ok(docker(['port',name,'5432/tcp']));assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connectionString=`postgres://postgres@${address}/b2a`;
 client=new Client({connectionString});await client.connect();
 await client.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await client.query(read('packages/db/tests/content-erasure/fixture.sql'));
 await runCases({db:client,Client,connectionString,report});
 await runFusionReview({db:client,Client,connectionString,report});
 await runFusionBackground({db:client,Client,connectionString,report});
 await runFusionFee({db:client,Client,connectionString,report});
 await runFusionPausedEnd({db:client,Client,connectionString,report});
 await runReportFee({db:client,Client,connectionString,report});
 const audits=ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
 assert.equal(audits,'');report.checks.push('account-open policy audit unchanged');
} catch(error) {report.failed=String(error.stack??error);process.exitCode=1;}
finally {
 await client?.end();report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
 if(report.cleanup!=='PASS')process.exitCode=1;
 console.log(JSON.stringify(report,null,2));
}
