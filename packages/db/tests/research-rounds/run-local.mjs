/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0492 (Owner 2026-11-03, "同意供应商故障那次不算一轮"): research_benchmark_rounds on core-path rows. A keyword discovery the data supplier could
// not serve at all (cursor.supplierDown, set by the API for 402/401/403/429/5xx with nothing found) is saved but is not a round; a part-served
// one, one the supplier answered normally with nothing found, and a pasted-link check that fetched the profile still are. The fallback card
// (research_benchmark_shortfall_offer) needs one qualified benchmark and two rounds. Rows are written the way research_turn_apply writes them.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const refusal=async promise=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
let turn=1000;
async function session(){
 const actor=randomUUID(),id=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,0)',[actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,id};
}
/** A keyword discovery of one turn, saved as research_turn_apply saves it. */
async function discovery(s,{cursor={},state='completed',turnId=++turn}={}){
 await c.query(`insert into research_discoveries(id,actor_id,session_id,turn_actor_id,turn_id,keyword_confirmation_id,platforms,keywords,cursor,state)
  values($1,$2,$3,$2,$4,$5,array['tiktok'],'["k"]'::jsonb,$6,$7)`,[randomUUID(),s.actor,s.id,turnId,randomUUID(),JSON.stringify(cursor),state]);
 return turnId;
}
/** An account fetched from a link the user pasted in `turnId` (succeeded), optionally a qualified benchmark. */
async function pasted(s,turnId,{qualified=false}={}){
 const account='a'+randomUUID().slice(0,8);
 const fetch=await one(`insert into research_account_fetches(actor_id,session_id,platform,account,account_key,state,turn_actor_id,turn_id,last_success_turn_id,pasted_turns)
  values($1,$2,'tiktok',$3,encode(sha256(convert_to($3,'UTF8')),'hex'),'succeeded',$1,$4,$4,array[$4::bigint]) returning id v`,[s.actor,s.id,account,turnId]);
 if(qualified) await c.query(`insert into research_benchmarks(fetch_id,actor_id,session_id,turn_actor_id,turn_id,platform,account,followers,posts_analyzed,
  category,qualified,whole_history,refs,operation_ids,missing,fetched_at,last_published_at) values($1,$2,$3,$2,$4,'tiktok','q',50000,25,'imitable',true,true,
  '{}'::jsonb,'{}','{}',now(),now())`,[fetch,s.actor,s.id,turnId]);
 return fetch;
}
const rounds=s=>one('select research_benchmark_rounds($1,$2) v',[s.actor,s.id]);
const qualified=s=>one('select research_benchmark_qualified($1,$2) v',[s.actor,s.id]);
const offer=s=>c.query('select research_benchmark_shortfall_offer($1,$2,null,$3) v',[s.actor,s.id,randomUUID()]).then(r=>r.rows[0].v);
const down={supplierDown:true,accounts:[],attempted:3};
try{
 // 1. The discovery kinds.
 {
  const s=await session();
  await discovery(s,{cursor:down});
  assert.equal(await rounds(s),0,'a round the supplier could not serve at all is not a round');
  await discovery(s,{cursor:{accounts:[],attempted:3}});
  assert.equal(await rounds(s),1,'the supplier answered normally and found nothing: a round');
  await discovery(s,{cursor:{accounts:[{key:'tiktok:x'}],attempted:3}});
  assert.equal(await rounds(s),2,'part of the data came out: a round');
  await discovery(s,{cursor:{},state:'running'});
  assert.equal(await rounds(s),2,'a running discovery is not a round (unchanged)');
  assert.equal(await one("select count(*)::int v from research_discoveries where session_id=$1 and state='completed'",[s.id]),3,'the supplier-down round is still saved');
  const old=await session();
  await c.query(`insert into research_discoveries(id,actor_id,session_id,turn_actor_id,turn_id,keyword_confirmation_id,platforms,keywords,cursor,state)
   values($1,$2,$3,$2,$4,$5,array['tiktok'],'["k"]'::jsonb,'{}','completed')`,[randomUUID(),old.actor,old.id,++turn,randomUUID()]);
  assert.equal(await rounds(old),1,'a discovery saved before 0492 has no mark and counts as before');
  report.checks.push('supplier-down discovery: not counted (still saved); honestly empty, part-served, and pre-0492 discoveries: counted; running: not counted');
 }
 // 2. Pasted-link checks.
 {
  const s=await session();
  await pasted(s,++turn);
  assert.equal(await rounds(s),1,'a pasted-link check that fetched the profile is a round');
  const t=await discovery(s,{cursor:down});
  assert.equal(await rounds(s),1,'a supplier-down discovery adds nothing');
  await pasted(s,t);
  assert.equal(await rounds(s),2,'the link check of a turn whose discovery did not count is a round of its own');
  const u=await discovery(s,{cursor:{accounts:[],attempted:1}});
  await pasted(s,u);
  assert.equal(await rounds(s),3,'one turn with a counted discovery and a link check: one round, as before');
  report.checks.push('pasted-link checks still count, also on a turn whose discovery did not; one turn with a counted discovery stays one round');
 }
 // 3. The fallback card: one qualified benchmark and two rounds.
 {
  const s=await session();
  await pasted(s,++turn,{qualified:true});          // 1 qualified, and its link check is round 1
  assert.equal(await qualified(s),1);
  assert.equal(await rounds(s),1);
  await discovery(s,{cursor:down});                  // an outage: would have been round 2 before 0492
  assert.equal(await rounds(s),1);
  assert.match(await refusal(offer(s)),/RESEARCH_SHORTFALL_NOT_DUE/,'one qualified benchmark plus a supplier-down search: no fallback card');
  await discovery(s,{cursor:{accounts:[],attempted:3}}); // the supplier is back: a real round
  const card=await offer(s);
  assert.deepEqual([card.required,card.offeredQualified,card.offeredRounds],[3,1,2]);
  report.checks.push('1 qualified + a supplier-down search: no fallback card; the next real round makes it due');
 }
 // 4. Service role only, as 0320 granted it; the body keeps its signature and result type.
 {
  assert.equal(await one("select pg_get_function_result('research_benchmark_rounds(uuid,uuid)'::regprocedure) v"),'integer');
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',false]])
   assert.equal(await one("select has_function_privilege($1,'public.research_benchmark_rounds(uuid,uuid)','EXECUTE') v",[role]),want,role);
  report.checks.push('signature, result type and privileges unchanged (not callable by API roles)');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
