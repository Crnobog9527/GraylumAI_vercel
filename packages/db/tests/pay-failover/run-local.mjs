/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local disposable PostgreSQL only. No credentials, remote database, or provider API.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import {runCases} from './cases.mjs';
const root=resolve(import.meta.dirname,'../../../..');
const name=`graylum-failover-${randomUUID().slice(0,8)}`;
const command=(argv,input)=>{
 const r=spawnSync('docker',argv,{input,encoding:'utf8',timeout:300000,maxBuffer:64*1024*1024});
 if(r.status!==0||r.error)throw new Error(r.stderr||String(r.error));return r.stdout.trim();
};
const endpoint=command(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
assert.match(endpoint,/^unix:\/\//,'local Docker only');
const docker=(argv,input)=>command(['--host',endpoint,...argv],input);
const sql=input=>docker(['exec','-i',name,'psql','-X','-qAt','-U','postgres','-d','failover','-v','ON_ERROR_STOP=1'],input);
const clients=[];
try {
 docker(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=failover',
  '-p','127.0.0.1::5432',POSTGRES_IMAGE]);
 for(let attempt=0;attempt<50;attempt++){
  try{sql('SELECT 1');break;}catch{await new Promise(r=>setTimeout(r,200));}
 }
 installPgCronStub(root,name,(argv,input)=>docker(['exec',...argv],input));
 const apply=input=>{try{sql(input);return {ok:true};}catch(e){return {ok:false,error:e.message};}};
 const read=p=>readFileSync(resolve(root,p),'utf8');
 const fingerprint=()=>JSON.parse(sql(read('packages/db/tests/baseline/fingerprint.sql')));
 const report=buildFromFiles(root,{applyFile:path=>apply(read(path)),applyServerOnly:apply,
  fingerprint:process.argv.includes('--quick')?undefined:fingerprint});
 assert.equal(report.failed,null,JSON.stringify(report));
 const before=fingerprint();sql(read('packages/db/migrations/0335_pay_failover.sql'));
 assert.deepEqual(fingerprint(),before,'repeat migration preserves complete structure');
 const port=Number(docker(['port',name,'5432/tcp']).split(':').at(-1));
 const connect=async()=>{
  const c=new pg.Client({host:'127.0.0.1',port,database:'failover',user:'postgres',statement_timeout:15000});
  clients.push(c);await c.connect();return c;
 };
 const admin=await connect(),service=await connect();await service.query('SET ROLE service_role');
 const cases=await runCases({admin,service,connect});
 console.log(JSON.stringify({result:'PASS',replay:report,cases}));
} finally {
 await Promise.all(clients.map(c=>c.query('ROLLBACK').catch(()=>{})));
 await Promise.all(clients.map(c=>c.end()));
 try{docker(['rm','-f','-v',name]);}catch{/* preserve original failure */}
}
