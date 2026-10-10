/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {localDb, read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(), c=db.client;
const hash=text=>createHash('sha256').update(text).digest('hex');
const report={build:db.build,checks:[]};
try {
 const migration=read('packages/db/migrations/0205_agent_core_read_skill_file.sql');
 const definition=async()=>(await c.query("SELECT pg_get_functiondef('runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb)'::regprocedure) v")).rows[0].v;
 const first=await definition();
 await c.query(migration); await c.query(migration);
 assert.equal(await definition(),first);
 report.checks.push('0205 repeats preserve function definition');
 await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 const f=(await c.query('SELECT runtime_perf_test.seed(1) f')).rows[0].f;
 const skill=randomUUID(), revision=randomUUID(), module=randomUUID();
 const files=[{path:'SKILL.md',content:'Synthetic Skill'}, {path:'ref.md',content:'Private synthetic reference'}];
 const manifest={packageId:skill,revisionId:revision,directoryName:'test',files:files.map(file=>({
  path:file.path,bytes:Buffer.byteLength(file.content),sha256:hash(file.content),mediaType:'text/markdown',requires:[],
 })),tasks:{},requiredCapabilities:[]};
 const payload=JSON.stringify({...manifest,files:manifest.files.map(file=>[file.path,file.bytes,file.mediaType,file.sha256,[]]),tasks:[]});
 manifest.packageHash=hash(payload);
 await c.query("UPDATE profiles SET role='admin' WHERE id=$1",[f.actor]);
 await c.query("INSERT INTO skills(id,skill_key,draft_content,created_by,updated_by) VALUES($1,$2,'',$3,$3)",[skill,'r1-'+skill,f.actor]);
 await c.query('SELECT atomic_publish_skill_package($1,$2,$3,$4,0,$5,$6,$7)',[
  skill,f.actor,revision,randomUUID(),manifest,payload,JSON.stringify(files.map(file=>({path:file.path,base64:Buffer.from(file.content).toString('base64')}))),
 ]);
 await c.query("INSERT INTO modules(id,title,skill_id,model_id,active) VALUES($1,'R1 synthetic',$2,$3,true)",[module,skill,f.model]);
 const binding={packageId:skill,revisionId:revision,packageHash:manifest.packageHash};
 await c.query(`UPDATE runtime_executions SET state='running',payload=payload||$2::jsonb WHERE id=$1`,[f.execution,JSON.stringify({
  role:'skill',providerRequestFormat:'agent-turn-v5-stream',moduleId:module,skillId:skill,revisionId:revision,
  skillFile:binding,tools:['read_skill_file'],maxToolCalls:1,
 })]);
 const identity=(await c.query(`SELECT p.status,p.is_deleted,m.active,s.status skill_status,s.content_kind
  FROM profiles p,modules m,skills s WHERE p.id=$1 AND m.id=$2 AND s.id=$3`,[f.actor,module,skill])).rows[0];
 assert.deepEqual(identity,{status:'active',is_deleted:'false',active:true,skill_status:'published',content_kind:'directory'});
 const call=async(action,args={path:'ref.md'},result=null,actor=f.actor,id='read_1')=>(await c.query(
  "SELECT runtime_tool($1,$2,$3,'read_skill_file',$4,$5,$6) v",[actor,f.execution,id,args,action,result])).rows[0].v;
 await assert.rejects(call('claim',{path:'../secret'}),/RUNTIME_SKILL_FILE_DENIED/);
 await assert.rejects(call('claim',{path:'ref.md',revisionId:randomUUID()}),/RUNTIME_SKILL_FILE_DENIED/);
 await assert.rejects(call('claim',{path:'ref.md'},null,randomUUID()),/BILL2_ACTOR_DENIED|RUNTIME_TOOL_DENIED/);
 assert.equal((await call('claim')).execute,true);
 const result={...binding,path:'ref.md',sha256:hash(files[1].content),content:files[1].content};
 await assert.rejects(call('complete',{path:'ref.md'},{...result,content:'forged'}),/RUNTIME_SKILL_FILE_CONFLICT/);
 assert.deepEqual((await call('complete',{path:'ref.md'},result)).result,result);
 assert.deepEqual((await call('claim')).result,result);
 await assert.rejects(call('claim',{path:'SKILL.md'},null,f.actor,'read_2'),/RUNTIME_TOOL_LIMIT/);
 report.checks.push('allowed read, invalid path, extra arguments, actor denial, forged result, replay, call limit');
 await c.query('UPDATE bill2_runs SET cancel_requested=true WHERE id=$1',[f.run]);
 await assert.rejects(call('complete',{path:'ref.md'},result),/RUNTIME_TOOL_CLOSED/);
 await c.query('UPDATE bill2_runs SET cancel_requested=false WHERE id=$1',[f.run]);
 await c.query('INSERT INTO skill_revision_revocations(revision_id,revoked_by) VALUES($1,$2)',[revision,f.actor]);
 await assert.rejects(call('claim'),/Skill unavailable/);
 report.checks.push('cancel refuses completion; revoked publication refuses saved replay');
 for(const role of ['anon','authenticated']){
  assert.equal((await c.query("SELECT has_function_privilege($1,'runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb)','execute') v",[role])).rows[0].v,false);
 }
 report.checks.push('public clients cannot invoke private tool journal');
 console.log(JSON.stringify(report,null,2));
} finally {await db.close();}
