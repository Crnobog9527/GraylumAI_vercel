/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const index=(db,a,sid)=>rpc(db,'runtime_workspace_source',a,sid,'');
const read=(db,a,sid,id)=>rpc(db,'runtime_workspace_source',a,sid,id);
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code));};
// oldDefinition: 0131's runtime_workspace_source, executed inside a rolled-back transaction.
export async function runCases({db,report,oldDefinition,oldErasureScope}) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const main=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Tea studio','POSITIONING_CANARY_A']);

 await db.query('BEGIN');
 try {
  await db.query(oldDefinition);
  assert.deepEqual((await index(db,a,sid)).entries,[]);
  assert.equal((await read(db,a,sid,main.business)).kind,'unavailable');
  report.checks.push('before fix (0131): confirmed positioning without an account is not listed or readable');
 } finally {await db.query('ROLLBACK');}

 const listed=await index(db,a,sid);
 assert.equal(listed.entries.length,1);
 const {confirmedAt,...identity}=listed.entries[0];
 assert.deepEqual(identity,{id:main.business,kind:'positioning',name:'Tea studio',sourceVersionId:main.version});
 assert.ok(!Number.isNaN(Date.parse(confirmedAt)));
 assert.deepEqual(listed.dependencies,[main.version]);
 const body=await read(db,a,sid,main.business);
 assert.equal(body.kind,'workspace_source');assert.equal(body.identity.kind,'positioning');
 assert.ok(body.body.includes('POSITIONING_CANARY_A'));assert.ok(!body.body.includes('DRAFT_POSITIONING_CANARY_A'));
 assert.equal(body.truncated,false);assert.deepEqual(body.dependencies,[main.version]);
 report.checks.push('after fix: confirmed positioning is listed and readable; the open draft round is not');

 const second=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Pottery shop','POSITIONING_CANARY_B']);
 const pending=await one(db,'SELECT ws_test.positioning($1,$2,$3,false) v',[a,'Unconfirmed','UNCONFIRMED_CANARY']);
 const names=(await index(db,a,sid)).entries.map(e=>e.kind+':'+e.name).sort();
 assert.deepEqual(names,['positioning:Pottery shop','positioning:Tea studio']);
 assert.ok((await read(db,a,sid,second.business)).body.includes('POSITIONING_CANARY_B'));
 assert.equal((await read(db,a,sid,pending.business)).kind,'unavailable');
 assert.ok(!JSON.stringify(await index(db,a,sid)).includes('UNCONFIRMED'));
 report.checks.push('multiple confirmed positionings are listed by name; an unconfirmed one is not listed or readable');

 const other=await one(db,'SELECT ws_test.actor() v');
 const otherSid=await one(db,'SELECT ws_test.free_session($1) v',[other]);
 assert.deepEqual((await index(db,other,otherSid)).entries,[]);
 assert.equal((await read(db,other,otherSid,main.business)).kind,'unavailable');
 await denied(read(db,other,sid,main.business),'RUNTIME_WORKSPACE_DENIED');
 await denied(index(db,a,main.draftSession),'RUNTIME_WORKSPACE_DENIED');
 report.checks.push('another user cannot list or read it, nor use the owner session; positioning sessions are not free sessions');

 await db.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[second.draft]);
 assert.equal((await read(db,a,sid,second.business)).kind,'unavailable');
 await db.query('UPDATE opc_businesses SET erased_at=now(),name=NULL WHERE id=$1',[main.business]);
 assert.equal((await read(db,a,sid,main.business)).kind,'unavailable');
 assert.deepEqual((await index(db,a,sid)).entries,[]);
 report.checks.push('revoked positioning draft and erased business are no longer readable');

 const d=await one(db,'SELECT ws_test.actor() v');
 const dSid=await one(db,'SELECT ws_test.free_session($1) v',[d]);
 const deleted=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[d,'Deleted','DELETED_CANARY']);
 const execution=async calls=>{
  const id=randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   VALUES($1,$2,$3,$4,'{}',0,'interrupted')`,[id,d,dSid,randomUUID()]);
  for(const [n,[args,result]] of calls.entries())await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
   VALUES($1,$2,'read_source',$3,$4)`,[id,'call-'+n,args,result]);
  return id;
 };
 const copied=await execution([[{},await index(db,d,dSid)],[{query:deleted.business},await read(db,d,dSid,deleted.business)]]);
 const unrelated=await execution([]);
 const scoped=async()=>(await rpc(db,'content_erasure_scope',d,'artifact',deleted.project)).executions;
 await db.query('BEGIN');
 try {
  await db.query(oldErasureScope);
  assert.ok(!(await scoped()).includes(copied));
  report.checks.push('before fix (0201 scope): deleting the positioning misses the answer that copied it via read_source');
 } finally {await db.query('ROLLBACK');}
 const covered=await scoped();
 assert.ok(covered.includes(copied));assert.ok(!covered.includes(unrelated));
 await erase(db,{actor:d},'artifact',deleted.project);
 const left=await db.query('SELECT count(*)::int n FROM runtime_tool_calls WHERE execution_id=$1 AND (result IS NOT NULL OR erased_at IS NULL)',[copied]);
 assert.equal(left.rows[0].n,0);
 assert.equal((await one(db,'SELECT content_deleted_at IS NULL AND erased_at IS NULL v FROM runtime_executions WHERE id=$1',[unrelated])),true);
 assert.deepEqual((await index(db,d,dSid)).entries,[]);
 assert.equal((await read(db,d,dSid,deleted.business)).kind,'unavailable');
 report.checks.push('after fix: deleting the positioning clears copied read_source results, keeps unrelated answers, and removes it from the index');

 const closing=await one(db,'SELECT ws_test.actor() v');
 const closingSid=await one(db,'SELECT ws_test.free_session($1) v',[closing]);
 const kept=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[closing,'Closing','CLOSING_CANARY']);
 assert.ok((await read(db,closing,closingSid,kept.business)).body.includes('CLOSING_CANARY'));
 await closeAccount(db,{actor:closing});
 await denied(read(db,closing,closingSid,kept.business),'BILL2_ACTOR_DENIED');
 await denied(index(db,closing,closingSid),'BILL2_ACTOR_DENIED');
 report.checks.push('after account closure the same positioning is denied');

 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_workspace_source(uuid,uuid,text)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('execute stays service_role only');
}
