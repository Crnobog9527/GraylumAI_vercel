/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const read=(db,a,e,query='')=>rpc(db,'runtime_mentor_history',a,e,query);
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code));};
const exec=(db,a,sid,input,seconds,state='completed',reader=false,extra={})=>
 one(db,'SELECT mh_test.exec($1,$2,$3,$4,$5,$6,$7) v',[a,sid,input,seconds,state,reader,extra]);
// A positioning conversation: ten user messages, host turns that are not the user's words, then the reading turn.
async function conversation(db,name) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const p=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,name,name+'_CANARY']);
 const sid=p.draftSession,messages=[];
 await exec(db,a,sid,'HOST_OPEN_CURRENT_QUESTION',0);
 for(let i=1;i<=10;i++)messages.push(await exec(db,a,sid,`${name} early message ${i}`,i*10));
 await exec(db,a,sid,'HOST_STEP_SUMMARY:v1',105);
 await exec(db,a,sid,'HOST_CHECKLIST_UPDATED:["goal"]',104);
 await exec(db,a,sid,`${name} cancelled message`,106,'cancelled');
 await exec(db,a,sid,`${name} organizer input`,107,'completed',false,{role:'organizer'});
 const current=await exec(db,a,sid,'what did I say first?',200,'running',true);
 await exec(db,a,sid,`${name} later message`,300);
 return {a,p,sid,messages,current};
}
export async function runCases({db,Client,connectionString,report}) {
 const c=await conversation(db,'main');
 const first=await read(db,c.a,c.current);
 assert.equal(first.kind,'mentor_history');assert.equal(first.segment,'segment-1');assert.equal(first.messages,10);
 assert.deepEqual(first.items.map(i=>i.text),Array.from({length:8},(_,i)=>`main early message ${i+1}`));
 assert.deepEqual(first.items.map(i=>i.executionId),c.messages.slice(0,8));
 assert.deepEqual(first.segments.map(s=>[s.id,s.turns]),[['segment-1',[1,8]],['segment-2',[9,10]]]);
 assert.equal(first.truncated,false);
 const text=JSON.stringify(first);
 for(const hidden of ['HOST_OPEN','HOST_STEP_SUMMARY','HOST_CHECKLIST_UPDATED','cancelled message','organizer input','later message','what did I say first'])
  assert.ok(!text.includes(hidden),hidden);
 report.checks.push('no query: earliest segment of the user\'s own completed messages, index of segments; host turns (opening, step summary, checklist update), cancelled turns, organizer runs, the current and later turns excluded');
 const second=await read(db,c.a,c.current,'segment-2');
 assert.deepEqual(second.items.map(i=>[i.turn,i.text]),[[9,'main early message 9'],[10,'main early message 10']]);
 for(const query of ['segment-3','segment-0','anything','segment-1;drop'])assert.equal((await read(db,c.a,c.current,query)).kind,'unavailable',query);
 report.checks.push('segment id reads that segment; unknown or malformed ids are unavailable');

 const long=await one(db,'SELECT ws_test.actor() v');
 const lp=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[long,'Long','LONG_CANARY']);
 for(let i=1;i<=3;i++)await exec(db,long,lp.draftSession,'"\\\n'.repeat(700)+'长'.repeat(1000)+i,i);
 const longCurrent=await exec(db,long,lp.draftSession,'now',10,'running',true);
 const bounded=await read(db,long,longCurrent);
 assert.equal(bounded.truncated,true);
 assert.ok(bounded.items.reduce((n,i)=>n+[...i.text].length,0)<=2500);
 assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(bounded)))<=14336);
 report.checks.push('user text is capped at 2500 characters and the escaped result stays within 14336 bytes');

 const other=await one(db,'SELECT ws_test.actor() v');
 await denied(read(db,other,c.current),'RUNTIME_MENTOR_HISTORY_DENIED');
 const plain=await exec(db,c.a,c.sid,'not a reader',201,'running',false);
 await denied(read(db,c.a,plain),'RUNTIME_MENTOR_HISTORY_DENIED');
 await denied(read(db,c.a,c.messages[0]),'RUNTIME_MENTOR_HISTORY_DENIED');
 const free=await one(db,'SELECT ws_test.free_session($1) v',[c.a]);
 const freeReader=await exec(db,c.a,free,'free chat',202,'running',true);
 await denied(read(db,c.a,freeReader),'RUNTIME_MENTOR_HISTORY_DENIED');
 report.checks.push('denied: another user, an execution not frozen with historyRead, a finished execution, a free conversation');

 const def=await one(db,"SELECT pg_get_functiondef('public.runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb)'::regprocedure) v");
 assert.ok(def.includes("'read_history'")&&def.includes("p_name='read_history' AND e.payload->'historyRead' IS NULL"));
 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_mentor_history(uuid,uuid,text)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('runtime_tool admits read_history only with historyRead; reader executes for service_role only');

 // A finished turn that copied messages 1-8, and an in-flight read claimed before a deletion.
 const copier=await exec(db,c.a,c.sid,'copier',210);
 await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'h1','read_history','{"query":null}',$2)`,[copier,first]);
 const unrelated=await exec(db,c.a,c.sid,'unrelated',220);
 await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments) VALUES($1,'h1','read_history','{"query":null}')`,[c.current]);
 const complete=()=>db.query("UPDATE runtime_tool_calls SET result=$2 WHERE execution_id=$1 AND call_id='h1'",[c.current,first]);
 const eraser=new Client({connectionString});await eraser.connect();
 try {
  await eraser.query('BEGIN');
  await eraser.query('SELECT id FROM artifact_projects WHERE actor_id=$1 ORDER BY id FOR UPDATE',[c.a]);
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='300ms'");
  await assert.rejects(complete(),error=>error.code==='55P03');
  await db.query('ROLLBACK');
  report.checks.push('completing a history read waits while an erasure holds the conversation project');
 } finally {await eraser.query('ROLLBACK');await eraser.end();}
 const scope=await rpc(db,'content_erasure_scope',c.a,'answer',c.messages[0]);
 assert.ok(scope.executions.includes(copier));assert.ok(!scope.executions.includes(unrelated));
 await erase(db,{actor:c.a},'answer',c.messages[0]);
 assert.equal(await one(db,"SELECT result IS NULL AND erased_at IS NOT NULL v FROM runtime_tool_calls WHERE execution_id=$1",[copier]),true);
 await denied(complete(),'RUNTIME_MENTOR_HISTORY_REVOKED');
 const after=await read(db,c.a,c.current);
 assert.ok(!JSON.stringify(after).includes('main early message 1"'));assert.equal(after.messages,9);
 report.checks.push('deleting an earlier answer deletes the answer that copied it, rejects an in-flight copy, and drops it from later reads');

 await db.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[c.p.draft]);
 await denied(read(db,c.a,c.current),'RUNTIME_MENTOR_HISTORY_DENIED');
 report.checks.push('a revoked positioning draft is no longer readable');

 const closing=await conversation(db,'closing');
 assert.equal((await read(db,closing.a,closing.current)).kind,'mentor_history');
 await closeAccount(db,{actor:closing.a});
 await denied(read(db,closing.a,closing.current),'BILL2_ACTOR_DENIED');
 report.checks.push('after account closure the conversation is denied');
}
