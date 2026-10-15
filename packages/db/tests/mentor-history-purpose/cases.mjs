/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const exec=(db,a,sid,input,seconds,purpose='mentor',state='completed',reader=false)=>
 one(db,'SELECT mh_test.exec($1,$2,$3,$4,$5,$6,$7,$8) v',[a,sid,input,seconds,state,reader,{},purpose]);
// 0245: plan generations and legacy step runs share the draft's session; only mentor turns are the user's words.
export async function runCases({db,report,oldMessages}) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const p=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Purpose','PURPOSE_CANARY']);
 const sid=p.draftSession;
 const mentor=[await exec(db,a,sid,'mentor message one',10)];
 await exec(db,a,sid,JSON.stringify({kind:'plan',brief:'PLAN_HOST_JSON'}),20,'plan');
 await exec(db,a,sid,JSON.stringify({kind:'step',body:'STEP_HOST_JSON'}),30,'step');
 await exec(db,a,sid,'NO_TURN_RECORD',35,null);
 mentor.push(await exec(db,a,sid,'mentor message two',40));
 // A token recorded for another draft's session never vouches for this one.
 const other=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Other','OTHER_CANARY']);
 const borrowed=await exec(db,a,other.draftSession,'OTHER_DRAFT_TURN',45);
 await db.query("UPDATE runtime_executions SET session_id=$2 WHERE id=$1",[borrowed,sid]);
 const current=await exec(db,a,sid,'what did I say?',50,'mentor','running',true);
 await db.query('BEGIN');
 try {
  await db.query(oldMessages);
  const before=JSON.stringify(await rpc(db,'runtime_mentor_history',a,current,''));
  assert.ok(before.includes('PLAN_HOST_JSON')&&before.includes('STEP_HOST_JSON'));
  report.checks.push('before fix (0228): plan and step host JSON is returned as the user\'s words');
 } finally {await db.query('ROLLBACK');}
 const result=await rpc(db,'runtime_mentor_history',a,current,'');
 assert.equal(result.kind,'mentor_history');assert.equal(result.messages,2);
 assert.deepEqual(result.items.map(i=>[i.turn,i.text,i.executionId]),
  [[1,'mentor message one',mentor[0]],[2,'mentor message two',mentor[1]]]);
 const text=JSON.stringify(result);
 for(const hidden of ['PLAN_HOST_JSON','STEP_HOST_JSON','NO_TURN_RECORD','OTHER_DRAFT_TURN'])assert.ok(!text.includes(hidden),hidden);
 report.checks.push('plan and step runs, executions without a turn record and turns of another draft are excluded; mentor turns are returned in order');
 const def=await one(db,"SELECT pg_get_functiondef('public.runtime_mentor_messages(uuid,runtime_executions)'::regprocedure) v");
 assert.ok(def.includes("t.purpose='mentor'"));
 report.checks.push('runtime_mentor_messages requires a mentor opc_turns record');
}
