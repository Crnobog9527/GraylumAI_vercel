/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
assert.ok(process.argv[2]==='--local-only'&&!process.env.CI || process.argv[2]==='--ci'&&process.env.CI,
  'use --local-only locally or --ci in CI; only an isolated local database is supported');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const run=(args,input)=>{
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
 if(r.status!==0||r.error) throw Error(r.stderr||String(r.error));
 return r.stdout.trim();
};
const endpoint=run(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
assert.match(endpoint,/^unix:\/\//);
const docker=(args,input)=>run(['--host',endpoint,...args],input);
docker(['image','inspect',POSTGRES_IMAGE]);
const name='graylum-profile-archive-'+randomUUID().slice(0,8);
const sql=input=>docker(['exec','-i',name,'psql','-XqAt','-U','postgres','-d','archive',
 '-v','ON_ERROR_STOP=1','-f','/dev/stdin'],input);
const clients=[];
const report={checks:[]};
try {
 docker(['run','-d','--pull=never','--name',name,'-e','POSTGRES_DB=archive','-e','POSTGRES_HOST_AUTH_METHOD=trust',
  '-p','127.0.0.1::5432',POSTGRES_IMAGE]);
 let ready=false;
 for(let i=0;i<100&&!ready;i++) {
  try {sql('SELECT 1');ready=true;} catch {await new Promise(r=>setTimeout(r,100));}
 }
 assert.ok(ready);
 installPgCronStub(root,name,(args,input)=>docker(['exec',...args],input));
 const apply=input=>{try {sql(input);return {ok:true};} catch(e) {return {ok:false,error:e.message};}};
 const objects=()=>JSON.parse(sql(read('packages/db/tests/baseline/fingerprint.sql')));
 let before,after;
 const legacyActor=randomUUID(),legacyBusiness=randomUUID();
 const build=buildFromFiles(root,{applyFile:path=>{
  const migration=read(path);
  if(!path.endsWith('_paywall_profile_archive.sql')) return apply(migration);
  sql(`INSERT INTO profiles(id) VALUES('${legacyActor}');
   INSERT INTO opc_businesses(id,actor_id,name) VALUES('${legacyBusiness}','${legacyActor}','Pre-0324 archive fixture');`);
  before=objects();
  const failed=apply(migration.replace(/COMMIT;\s*$/,
   "DO $$ BEGIN RAISE EXCEPTION 'ARCHIVE_ROLLBACK_PROBE'; END $$; COMMIT;"));
  assert.equal(failed.ok,false);
  assert.match(failed.error,/ARCHIVE_ROLLBACK_PROBE/);
  assert.deepEqual(objects(),before,'interrupted migration leaves original definitions, data shape and ACL unchanged');
  const applied=apply(migration);
  if(!applied.ok) return applied;
  after=objects();
  sql(migration);
  assert.deepEqual(objects(),after,'second application preserves structure and ACL');
  return applied;
 },applyServerOnly:apply});
 assert.equal(build.failed,null,JSON.stringify(build.failed));
 assert.ok(before&&after,'migration verified at its historical position');
 assert.equal(sql(`SELECT archived_at IS NULL FROM opc_businesses WHERE id='${legacyBusiness}'`),'t');
 report.build=build;
 report.checks.push('migration interruption rolls back every catalog object','migration repeat preserves structure and ACL');
 const port=Number(docker(['port',name,'5432/tcp']).split(':').at(-1));
 const connect=async()=>{
  const db=new pg.Client({host:'127.0.0.1',port,database:'archive',user:'postgres',statement_timeout:15000});
  clients.push(db);await db.connect();return db;
 };
 const admin=await connect();
 for(const [level,monthly,annual,credits] of [['free',0,0,0],['pro',2900,27900,3480],['gold',6900,62100,8970]]) {
  await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
   allow_fusion_review,allow_fusion_compare,library_storage_bytes)
   VALUES($1,$1,$2,$3,$4,$5,false,false,0) ON CONFLICT(level) DO NOTHING`,[level,monthly,annual,credits,credits*12]);
 }
 await runCases({admin,connect,report,read});
 const preserved=sql('SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM opc_businesses b');
 sql(read('packages/db/migrations/0324_paywall_profile_archive.sql'));
 assert.equal(sql('SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM opc_businesses b'),preserved,
  'forward recovery/reapply retains every archive, source and revision');
 assert.deepEqual(objects(),after);
 assert.equal(sql(read('packages/db/tests/account-open-policy-audit.sql')),'');
 report.checks.push('reapply retains archived content and releases no additional slots','account-open policy audit PASS');
 console.log(JSON.stringify({result:'PASS',...report}));
} finally {
 await Promise.all(clients.map(db=>db.query('ROLLBACK').catch(()=>{})));
 await Promise.all(clients.map(db=>db.end()));
 docker(['rm','-f',name]);
}
