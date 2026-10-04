/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline, dedicated PostgreSQL only. Never accepts a database URL or pulls images.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runtimeCases} from './runtime.mjs';

const development = process.argv.slice(2).join(' ')==='--local-only --development';
if ((!development&&process.argv.slice(2).join(' ')!=='--local-only')||process.env.CI) throw Error('Require --local-only outside CI');
const root = resolve(import.meta.dirname,'../../../..');
const read = path => readFileSync(resolve(root,path),'utf8');
const run = (args,input) => spawnSync('docker',args,{input,encoding:'utf8',cwd:root,
  env:{PATH:process.env.PATH,HOME:process.env.HOME},maxBuffer:64*1024*1024,timeout:300000});
const ok = result => {
  if (result.status!==0||result.error) throw Error((result.stderr||String(result.error)).slice(-5000));
  return result.stdout.trim();
};
const endpoint = ok(run(['context','inspect','--format','{{.Endpoints.docker.Host}}']));
assert.match(endpoint,/^unix:\/\/\/[^\n]+$/,'local Docker socket only');
const docker = (args,input) => run(['--host',endpoint,...args],input);
ok(docker(['image','inspect',POSTGRES_IMAGE]));
const name = `graylum-payg-${randomUUID().slice(0,8)}`;
const sql = input => docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','payg','-v','ON_ERROR_STOP=1'],input);
const outcome = result => ({ok:result.status===0&&!result.error,error:result.stderr});
const report = {development,build:null,checks:[],failed:null};
let db;
try {
  ok(docker(['run','-d','--pull=never','--name',name,'-p','127.0.0.1::5432',
    '-e','POSTGRES_DB=payg','-e','POSTGRES_HOST_AUTH_METHOD=trust',POSTGRES_IMAGE]));
  let ready = false;
  for (let i=0;i<300&&!ready;i++) {
    ready = docker(['exec',name,'pg_isready','-U','postgres','-d','payg']).status===0;
    if (!ready) await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,'local PostgreSQL ready');
  installPgCronStub(root,name,(args,input)=>ok(docker(['exec',...args],input)));
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const objectSql = fingerprint.slice(0,fingerprint.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
  let rollbackChecked=false;
  report.build = buildFromFiles(root,{
    applyFile:path=>{
      const migration=read(path);
      if (path.endsWith('0166_payg_runtime.sql')&&!rollbackChecked) {
        const before=JSON.parse(ok(sql(objectSql)));
        assert.match(migration,/COMMIT;\s*$/);
        const interrupted=sql(migration.replace(/COMMIT;\s*$/,
          "DO $$ BEGIN RAISE EXCEPTION 'PAYG_RUNTIME_TEST_ROLLBACK'; END $$; COMMIT;"));
        assert.notEqual(interrupted.status,0);
        assert.match(interrupted.stderr,/PAYG_RUNTIME_TEST_ROLLBACK/);
        assert.deepEqual(JSON.parse(ok(sql(objectSql))),before,'failed 0166 restores the complete pre-migration catalog');
        const signatures=[...migration.matchAll(/public\.([^']+)'::regprocedure/g)].map(m=>m[1]);
        for(const signature of signatures){
          const source=before['fn:'+signature];
          assert.ok(source,'immutable source catalog function');
          ok(sql(source.replace('BEGIN','BEGIN\n -- PAYG_RUNTIME_DRIFT_TEST')+';'));
          const drifted=JSON.parse(ok(sql(objectSql)));
          const refused=sql(migration);
          assert.notEqual(refused.status,0);
          assert.match(refused.stderr,/PAYG_RUNTIME_SOURCE_MISMATCH/);
          assert.deepEqual(JSON.parse(ok(sql(objectSql))),drifted,'md5 refusal makes no partial schema change');
          ok(sql(source+';'));
          assert.deepEqual(JSON.parse(ok(sql(objectSql))),before);
        }
        report.checks.push('every replaced function rejects synthetic source drift before DDL');
        rollbackChecked=true;
        report.checks.push('0166 failure before COMMIT rolls back all DDL and ACL to the exact pre-migration catalog');
      }
      return outcome(sql(migration));
    },
    applyServerOnly:input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','payg','-v','ON_ERROR_STOP=1','-c',input])),
    fingerprint:development?undefined:()=>JSON.parse(ok(sql(objectSql))),
  });
  assert.equal(report.build.failed,null,JSON.stringify(report.build.failed));
  const require = createRequire(resolve(root,'packages/api/package.json'));
  const {Client} = require('pg');
  const address = ok(docker(['port',name,'5432/tcp']));
  assert.match(address,/^127\.0\.0\.1:\d+$/);
  const connectionString = `postgres://postgres@${address}/payg`;
  db = new Client({connectionString});
  await db.connect();
  await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
  await runtimeCases({db,Client,connectionString,report});
} catch (error) {
  report.failed = String(error.stack??error);
  report.databaseError = {code:error.code,detail:error.detail,where:error.where,position:error.position};
  process.exitCode = 1;
} finally {
  await db?.end();
  report.cleanup = docker(['rm','-f','-v',name]).status===0?'PASS':'FAIL';
  if (report.cleanup!=='PASS') process.exitCode = 1;
  console.log(JSON.stringify(report,null,2));
}
