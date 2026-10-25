/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {ready,detach} from '../erasure-binding/cases.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';

// 0393 (staging 10-25): retained, erased research evidence keeps its session id, so that erased session shell cannot be
// deleted. It must not keep the account 'erasing' forever; a session with unerased research evidence still counts.
export async function runResearchRetained(db,report) {
 const remaining=async f=>Number((await db.query('SELECT account_erasure_business_remaining($1) n',[f.actor])).rows[0].n);
 const plan=(f,erased)=>db.query(`INSERT INTO research_plans(id,actor_id,budget_units,max_operations,operations,session_id,execution_id,erased_at)
  VALUES(gen_random_uuid(),$1,1,1,CASE WHEN NOT $4 THEN '[{}]'::jsonb END,$2,$3,CASE WHEN $4 THEN clock_timestamp() END) RETURNING id`,[f.actor,f.session,f.execution,erased]);
 const prune=async f=>{await detach(db,f);for(let i=0;i<3;i++)await rpc(db,'account_erasure_prune_business',f.actor,100);};
 const session=async f=>(await db.query('SELECT erased_at IS NOT NULL erased FROM runtime_sessions WHERE id=$1',[f.session])).rows[0];

 // The fixture never runs storage cleanup, so every subject keeps the same unrelated remainder; compare to a control.
 const control=await ready(db,{version:'v1'});
 await prune(control);
 const baseline=await remaining(control);
 const done=await ready(db,{version:'v1'});
 const kept=(await plan(done,true)).rows[0].id;
 const before=(await db.query('SELECT to_jsonb(p) v FROM research_plans p WHERE id=$1',[kept])).rows[0].v;
 await prune(done);
 assert.deepEqual(await session(done),{erased:true},'erased session shell retained as the research evidence context');
 assert.equal(await remaining(done),baseline,'retained research context is not remaining work');
 assert.deepEqual((await db.query('SELECT to_jsonb(p) v FROM research_plans p WHERE id=$1',[kept])).rows[0].v,before,
  'retained research evidence unchanged');

 const open=await ready(db,{version:'v1'});
 await plan(open,true);await plan(open,false);
 await prune(open);
 assert.ok(await remaining(open)>baseline,'a session with unerased research evidence still counts');
 report.checks.push('0393: erased research evidence context does not block completion; unerased evidence still counts');
}
