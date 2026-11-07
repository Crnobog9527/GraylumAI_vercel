/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT B1: free conversations list and read the benchmark table behind a confirmed positioning.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const index=(db,a,sid)=>rpc(db,'runtime_workspace_source',a,sid,'');
const read=(db,a,sid,id)=>rpc(db,'runtime_workspace_source',a,sid,id);
const denied=async(promise,code)=>{await assert.rejects(promise,error=>String(error.message).includes(code));};
const kinds=async(db,a,sid)=>(await index(db,a,sid)).entries.map(e=>e.kind);

let turnSeq=9000;
/** The turn that produced benchmark rows (a row is visible only with its turn since 0465; the turn row itself is not read by these functions). */
const answer=async()=>++turnSeq;
/** One benchmark row (one fetch each). qualified rows satisfy 0268's checks; others are excluded with no posts. */
async function benchmark(db,a,sid,turn,account,{qualified=false,followers=null}={}) {
 const fetch=await one(db,`INSERT INTO research_account_fetches(actor_id,session_id,platform,account,state,account_key,turn_actor_id,turn_id,last_success_turn_id)
  VALUES($1,$2,'tiktok',$3,'succeeded',encode(sha256(convert_to($3,'utf8')),'hex'),$1,$4,$4) RETURNING id v`,[a,sid,account,turn]);
 await db.query(`INSERT INTO research_benchmarks(fetch_id,actor_id,session_id,turn_actor_id,turn_id,platform,account,followers,median_views,
   engagement_rate,posts_per_week,last_published_at,posts_analyzed,category,qualified,excluded,refs,operation_ids,missing,fetched_at)
  VALUES($1,$2,$3,$2,$4,'tiktok',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}','{}',$15,now())`,
  qualified?[fetch,a,sid,turn,account,followers??50000,12000,0.031,3.5,new Date(),24,'imitable',true,null,[]]
   :[fetch,a,sid,turn,account,null,null,null,null,null,0,null,false,'NO_POSTS',['followers']]);
}

export async function runCases({db,Client,report}) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const main=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Tea studio','POSITIONING_CANARY_A']);
 assert.deepEqual(await kinds(db,a,sid),['positioning']);
 report.checks.push('without benchmark rows only the positioning is listed (0218 output unchanged)');

 const produced=await answer();
 await benchmark(db,a,main.draftSession,produced,'BENCH_QUALIFIED_CANARY',{qualified:true,followers:51234});
 await benchmark(db,a,main.draftSession,produced,'BENCH_EXCLUDED_CANARY');
 // (The old "before the fix (0218)" demonstration is not run any more: it applied 0218's function text, which reads dropped runtime tables.)

 const listed=await index(db,a,sid);
 assert.deepEqual(listed.entries.map(e=>e.kind),['positioning','benchmarks']);
 const {fetchedAt,use,producedBy,...entry}=listed.entries[1];
 assert.deepEqual(producedBy,[{turnId:produced}]);
 assert.deepEqual(entry,{id:main.draftSession,kind:'benchmarks',name:'Tea studio',sessionId:main.draftSession,
  accounts:2,qualified:1,sourceVersionId:main.version});
 assert.ok(!Number.isNaN(Date.parse(fetchedAt)));assert.ok(use.includes('only from this table'));
 assert.deepEqual(listed.dependencies,[main.version]);
 const body=await read(db,a,sid,main.draftSession);
 assert.equal(body.kind,'workspace_source');assert.equal(body.identity.kind,'benchmarks');
 assert.deepEqual(Object.keys(body.identity).sort(),['id','kind','name','sessionId','sourceVersionId','use']); // no per-answer aggregates
 const rows=JSON.parse(body.body);
 assert.deepEqual(rows.map(r=>[r.account,r.qualified,r.followers]),[['BENCH_QUALIFIED_CANARY',true,51234],['BENCH_EXCLUDED_CANARY',false,null]]);
 assert.deepEqual(rows[1].missing,['followers']);assert.equal(body.truncated,false);
 assert.deepEqual(body.dependencies,[main.version]);
 assert.deepEqual(body.producedBy,[{turnId:produced}]);
 // Body and provenance come from one query, yet the rows stay exactly what the positioning page's table shows (0268).
 assert.deepEqual(rows,(await rpc(db,'research_benchmark_table',a,main.draftSession)).rows);
 report.checks.push('after fix: the benchmark table is listed after the positioning and readable; missing numbers stay null');

 // A newer, unconfirmed draft of the same business with its own (newer) research is never used.
 const redo=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Redo','REDO_CANARY']);
 await db.query('UPDATE opc_draft_businesses SET business_id=$2 WHERE draft_id=$1',[redo.draft,main.business]);
 await db.query('UPDATE opc_businesses SET erased_at=now(),name=NULL WHERE id=$1',[redo.business]);
 await benchmark(db,a,redo.draftSession,await answer(),'UNCONFIRMED_DRAFT_BENCH',{qualified:true});
 const confirmedOnly=await read(db,a,sid,main.draftSession);
 assert.ok(confirmedOnly.body.includes('BENCH_QUALIFIED_CANARY'));
 assert.ok(!JSON.stringify(await index(db,a,sid)).includes(redo.draftSession));
 assert.equal((await read(db,a,sid,redo.draftSession)).kind,'unavailable');
 report.checks.push('research of a newer unconfirmed draft of the same business is not listed or readable');

 // Unrelated: the positioning read is unchanged.
 assert.ok((await read(db,a,sid,main.business)).body.includes('POSITIONING_CANARY_A'));
 const other=await one(db,'SELECT ws_test.actor() v');
 const otherSid=await one(db,'SELECT ws_test.free_session($1) v',[other]);
 assert.equal((await read(db,other,otherSid,main.draftSession)).kind,'unavailable');
 await denied(read(db,other,sid,main.draftSession),'RUNTIME_WORKSPACE_DENIED');
 await denied(index(db,a,main.draftSession),'RUNTIME_WORKSPACE_DENIED');
 report.checks.push('another user cannot read it; the positioning session itself is not a free session');

 // Many accounts: the body is capped at 8000 characters and says so.
 const big=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Big shop','BIG_CANARY']);
 const bigAnswer=await answer();
 for(let i=0;i<30;i++)await benchmark(db,a,big.draftSession,bigAnswer,`acct_${String(i).padStart(2,'0')}_${'x'.repeat(150)}`);
 const capped=await read(db,a,sid,big.draftSession);
 assert.equal(capped.truncated,true);assert.equal(capped.body.length,8000);
 report.checks.push('a large table is cut at 8000 characters with truncated=true');

 // (Not run any more, 0505: rows of a deleted answer. On the core path rows go with their conversation or account: research-benchmark-table, block 5.)

 // Revoking the positioning draft hides its benchmark table too.
 await db.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[main.draft]);
 assert.equal((await read(db,a,sid,main.draftSession)).kind,'unavailable');
 assert.ok(!(await index(db,a,sid)).entries.some(e=>e.kind==='benchmarks'&&e.id===main.draftSession),'its benchmark table is not listed (the other conversations\' tables still are)');
 report.checks.push('a revoked positioning lists neither the positioning nor its benchmark table');

 // (Not run any more, 0505: copies of the table inside old executions' tool calls, their scope, erasure and the write guards on them.)

 const closing=await one(db,'SELECT ws_test.actor() v');
 const closingSid=await one(db,'SELECT ws_test.free_session($1) v',[closing]);
 const kept=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[closing,'Closing','CLOSING_CANARY']);
 await benchmark(db,closing,kept.draftSession,await answer(),'CLOSING_BENCH',{qualified:true});
 assert.equal((await read(db,closing,closingSid,kept.draftSession)).kind,'workspace_source');
 await closeAccount(db,{actor:closing});
 await denied(read(db,closing,closingSid,kept.draftSession),'BILL2_ACTOR_DENIED');
 report.checks.push('after account closure the benchmark table is denied');

 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_workspace_source(uuid,uuid,text)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('execute stays service_role only');
}
