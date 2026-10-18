/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// Focused local-only post-merge revision repair; no URL or credentials accepted, no images pulled.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {createFixture} from './fixture.mjs';
import {fusionCompareCases} from './fusion-compare.mjs';
import {committedRevisionCase,concurrentRevisionCase,frozenReplayCase} from './fusion-revision-cases.mjs';

const development=process.argv.slice(2).join(' ')==='--local-only --development';
if((!development&&process.argv.slice(2).join(' ')!=='--local-only')||process.env.CI)throw Error('Require --local-only outside CI');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',cwd:root,
  env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok=result=>{
  if(result.status!==0||result.error)throw Error((result.stderr||String(result.error)).slice(-5000));
  return result.stdout.trim();
};
const endpoint=ok(run(['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.match(endpoint,/^unix:\/\/\/[^\n]+$/,'local Docker socket only');
const docker=(args,input)=>run(['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name=`graylum-fusion-revision-${randomUUID().slice(0,8)}`;
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','payg','-v','ON_ERROR_STOP=1'],input);
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const objectSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot=()=>JSON.parse(ok(sql(objectSql)));
const outcome=result=>({ok:result.status===0&&!result.error,error:result.stderr});
const migrationPath='packages/db/migrations/0310_fusion_compare_revision.sql';
const migration=read(migrationPath);
const report={development,build:null,checks:[],failed:null};
let db;
try {
  ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
    '-e','POSTGRES_DB=payg','-e','POSTGRES_HOST_AUTH_METHOD=trust',POSTGRES_IMAGE]));
  let ready=false;
  for(let i=0;i<300&&!ready;i++) {
    ready=docker(['exec',name,'pg_isready','-U','postgres','-d','payg']).status===0;
    if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,'local PostgreSQL ready');
  installPgCronStub(root,name,(args,input)=>ok(docker(['exec',...args],input)));
  report.build=buildFromFiles(root,{applyFile:path=>path===migrationPath?{ok:true}:outcome(sql(read(path))),
    applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','payg','-c',input])),
    fingerprint:development?undefined:snapshot});
  assert.equal(report.build.failed,null,JSON.stringify(report.build.failed));
  const require=createRequire(resolve(root,'packages/api/package.json'));
  const {Client}=require('pg');
  const address=ok(docker(['port',name,'5432/tcp']));
  assert.match(address,/^127\.0\.0\.1:\d+$/);
  const connectionString=`postgres://postgres@${address}/payg`;
  db=new Client({connectionString});
  await db.connect();
  await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
  const context={db,Client,connectionString,report,createFixture};
  await assert.rejects(committedRevisionCase(context),{code:'ERR_ASSERTION',message:/Missing expected rejection/});
  report.checks.push('RED: original group admission accepts a stale snapshot; new regression detects it');
  ok(sql(migration));
  const once=snapshot();
  ok(sql(migration));
  assert.deepEqual(snapshot(),once,'repair applied twice leaves the complete catalog unchanged');
  report.checks.push('0310 applied twice; complete catalog identical after repeat');
  await committedRevisionCase(context);
  report.checks.push('committed history advancement rejects admission without groups/runs/calls or credit changes');
  await concurrentRevisionCase(context);
  report.checks.push('concurrent turn commits before admission; session locks before compare; no groups/runs/calls/credit changes');
  await frozenReplayCase(context);
  report.checks.push('existing group replays identical frozen runs after conversation revision advances');
  await fusionCompareCases(context);
  report.checks.push('existing fusionCompareCases passed without modification');
} catch(error) {
  report.failed=String(error.stack??error);
  report.databaseError={code:error.code,detail:error.detail,where:error.where,position:error.position};
  process.exitCode=1;
} finally {
  await db?.end();
  report.cleanup=docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
  if(report.cleanup!=='PASS')process.exitCode=1;
  console.log(JSON.stringify(report,null,2));
}
