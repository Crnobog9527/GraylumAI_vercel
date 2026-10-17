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

/** An answer in the positioning session that produced benchmark rows; returns its id. */
async function answer(db,a,sid) {
 const id=randomUUID();
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4,'{}',0,'completed')`,[id,a,sid,randomUUID()]);
 return id;
}
/** One benchmark row (one fetch each). qualified rows satisfy 0268's checks; others are excluded with no posts. */
async function benchmark(db,a,sid,execution,account,{qualified=false,followers=null}={}) {
 const fetch=await one(db,`INSERT INTO research_account_fetches(actor_id,session_id,platform,account,state,account_key)
  VALUES($1,$2,'tiktok',$3,'failed',encode(sha256(convert_to($3,'utf8')),'hex')) RETURNING id v`,[a,sid,account]);
 await db.query(`INSERT INTO research_benchmarks(fetch_id,actor_id,session_id,execution_id,platform,account,followers,median_views,
   engagement_rate,posts_per_week,last_published_at,posts_analyzed,category,qualified,excluded,refs,operation_ids,missing,fetched_at)
  VALUES($1,$2,$3,$4,'tiktok',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}','{}',$15,now())`,
  qualified?[fetch,a,sid,execution,account,followers??50000,12000,0.031,3.5,new Date(),24,'imitable',true,null,[]]
   :[fetch,a,sid,execution,account,null,null,null,null,null,0,null,false,'NO_POSTS',['followers']]);
}

export async function runCases({db,Client,report,oldDefinition}) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const main=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Tea studio','POSITIONING_CANARY_A']);
 assert.deepEqual(await kinds(db,a,sid),['positioning']);
 report.checks.push('without benchmark rows only the positioning is listed (0218 output unchanged)');

 const produced=await answer(db,a,main.draftSession);
 await benchmark(db,a,main.draftSession,produced,'BENCH_QUALIFIED_CANARY',{qualified:true,followers:51234});
 await benchmark(db,a,main.draftSession,produced,'BENCH_EXCLUDED_CANARY');
 await db.query('BEGIN');
 try {
  await db.query(oldDefinition);
  assert.deepEqual(await kinds(db,a,sid),['positioning']);
  report.checks.push('before fix (0218): the benchmark table of a confirmed positioning is not listed');
 } finally {await db.query('ROLLBACK');}

 const listed=await index(db,a,sid);
 assert.deepEqual(listed.entries.map(e=>e.kind),['positioning','benchmarks']);
 const {fetchedAt,use,producedBy,...entry}=listed.entries[1];
 assert.deepEqual(producedBy,[{executionId:produced}]);
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
 assert.deepEqual(body.producedBy,[{executionId:produced}]);
 // Body and provenance come from one query, yet the rows stay exactly what the positioning page's table shows (0268).
 assert.deepEqual(rows,(await rpc(db,'research_benchmark_table',a,main.draftSession)).rows);
 report.checks.push('after fix: the benchmark table is listed after the positioning and readable; missing numbers stay null');

 // A newer, unconfirmed draft of the same business with its own (newer) research is never used.
 const redo=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Redo','REDO_CANARY']);
 await db.query('UPDATE opc_draft_businesses SET business_id=$2 WHERE draft_id=$1',[redo.draft,main.business]);
 await db.query('UPDATE opc_businesses SET erased_at=now(),name=NULL WHERE id=$1',[redo.business]);
 await benchmark(db,a,redo.draftSession,await answer(db,a,redo.draftSession),'UNCONFIRMED_DRAFT_BENCH',{qualified:true});
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
 const bigAnswer=await answer(db,a,big.draftSession);
 for(let i=0;i<30;i++)await benchmark(db,a,big.draftSession,bigAnswer,`acct_${String(i).padStart(2,'0')}_${'x'.repeat(150)}`);
 const capped=await read(db,a,sid,big.draftSession);
 assert.equal(capped.truncated,true);assert.equal(capped.body.length,8000);
 report.checks.push('a large table is cut at 8000 characters with truncated=true');

 // Rows of a deleted answer are gone from the table; with none left the entry is not listed.
 // Fixture shortcut: mark the answer deleted without running the erasure pipeline (its write guard is bypassed here only).
 await db.query('BEGIN');await db.query("SET LOCAL session_replication_role=replica");
 await db.query('UPDATE runtime_executions SET content_deleted_at=now() WHERE id=$1',[bigAnswer]);await db.query('COMMIT');
 assert.ok(!(await index(db,a,sid)).entries.some(e=>e.id===big.draftSession));
 assert.equal((await read(db,a,sid,big.draftSession)).kind,'unavailable');
 report.checks.push('rows from a deleted answer are not listed or readable');

 // Revoking the positioning draft hides its benchmark table too.
 await db.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1',[main.draft]);
 assert.equal((await read(db,a,sid,main.draftSession)).kind,'unavailable');
 assert.ok(!(await kinds(db,a,sid)).includes('benchmarks'));
 report.checks.push('a revoked positioning lists neither the positioning nor its benchmark table');

 // Deleting the positioning conversation clears free answers that copied the table.
 const d=await one(db,'SELECT ws_test.actor() v');
 const dSid=await one(db,'SELECT ws_test.free_session($1) v',[d]);
 const del=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[d,'Deleted','DELETED_CANARY']);
 const producer=await answer(db,d,del.draftSession);
 await benchmark(db,d,del.draftSession,producer,'DELETED_BENCH_CANARY',{qualified:true});
 const execution=async calls=>{
  const id=randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   VALUES($1,$2,$3,$4,'{}',0,'interrupted')`,[id,d,dSid,randomUUID()]);
  for(const [n,[args,result]] of calls.entries())await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
   VALUES($1,$2,'read_source',$3,$4)`,[id,'call-'+n,args,result]);
  return id;
 };
 const copied=await execution([[{query:del.draftSession},await read(db,d,dSid,del.draftSession)]]);
 const unrelated=await execution([]);
 // Deleting just the producing answer (internal path; users delete whole conversations) also finds the copy.
 assert.ok((await rpc(db,'content_erasure_scope',d,'answer',producer)).executions.includes(copied));
 const scope=(await rpc(db,'content_erasure_scope',d,'session',del.draftSession)).executions;
 assert.ok(scope.includes(copied));assert.ok(!scope.includes(unrelated));
 await erase(db,{actor:d},'session',del.draftSession);
 const left=await db.query('SELECT count(*)::int n FROM runtime_tool_calls WHERE execution_id=$1 AND (result IS NOT NULL OR erased_at IS NULL)',[copied]);
 assert.equal(left.rows[0].n,0);
 assert.equal(await one(db,'SELECT content_deleted_at IS NULL AND erased_at IS NULL v FROM runtime_executions WHERE id=$1',[unrelated]),true);
 assert.ok(!(await kinds(db,d,dSid)).includes('benchmarks'));
 report.checks.push('deleting the producing answer or the positioning conversation scopes free answers that copied the table; erasure clears them, keeps unrelated ones');

 // A read in flight when its producing answer is deleted cannot store the deleted rows afterwards.
 const g=await one(db,'SELECT ws_test.actor() v');
 const gSid=await one(db,'SELECT ws_test.free_session($1) v',[g]);
 const gPos=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[g,'Guarded','GUARD_CANARY']);
 const gProducer=await answer(db,g,gPos.draftSession);
 await benchmark(db,g,gPos.draftSession,gProducer,'GUARD_BENCH_CANARY',{qualified:true});
 const gBody=await read(db,g,gSid,gPos.draftSession);
 const gIndex=await index(db,g,gSid); // read while the producer is still live
 const gExec=randomUUID();
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4,'{}',0,'interrupted')`,[gExec,g,gSid,randomUUID()]);
 await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'call-0','read_source',$2,NULL)`,
  [gExec,{query:gPos.draftSession}]);
 const store=()=>db.query("UPDATE runtime_tool_calls SET result=$2 WHERE execution_id=$1 AND call_id='call-0'",[gExec,gBody]);
 // Only the producing answer goes (fixture shortcut, its write guard bypassed here only): the positioning stays valid,
 // so 0218's guard alone would accept the stale copy; only this migration's guard refuses it.
 await db.query('BEGIN');await db.query('SET LOCAL session_replication_role=replica');
 await db.query('UPDATE runtime_executions SET content_deleted_at=now() WHERE id=$1',[gProducer]);await db.query('COMMIT');
 assert.equal(await one(db,'SELECT opc_source_allowed($1,$2) v',[g,gPos.version]),true);
 await denied(store(),'RUNTIME_WORKSPACE_SOURCE_REVOKED');
 assert.equal(await one(db,"SELECT result IS NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='call-0'",[gExec]),true);
 report.checks.push('a benchmark read completed after its producing answer was deleted cannot store the deleted rows');
 // The same holds for an index listing the table: it carries the producers and is rechecked on save.
 assert.deepEqual(gIndex.entries.find(e=>e.kind==='benchmarks').producedBy,[{executionId:gProducer}]);
 const gExec2=randomUUID();
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4,'{}',0,'interrupted')`,[gExec2,g,gSid,randomUUID()]);
 await db.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'call-0','read_source','{}',NULL)`,[gExec2]);
 await denied(db.query("UPDATE runtime_tool_calls SET result=$2 WHERE execution_id=$1 AND call_id='call-0'",[gExec2,gIndex]),'RUNTIME_WORKSPACE_SOURCE_REVOKED');
 report.checks.push('an index listing the benchmark table carries its producers and is refused once a producer was deleted');

 const closing=await one(db,'SELECT ws_test.actor() v');
 const closingSid=await one(db,'SELECT ws_test.free_session($1) v',[closing]);
 const kept=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[closing,'Closing','CLOSING_CANARY']);
 await benchmark(db,closing,kept.draftSession,await answer(db,closing,kept.draftSession),'CLOSING_BENCH',{qualified:true});
 assert.equal((await read(db,closing,closingSid,kept.draftSession)).kind,'workspace_source');
 await closeAccount(db,{actor:closing});
 await denied(read(db,closing,closingSid,kept.draftSession),'BILL2_ACTOR_DENIED');
 report.checks.push('after account closure the benchmark table is denied');

 const grants=await db.query(`SELECT r, has_function_privilege(r,'public.runtime_workspace_source(uuid,uuid,text)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(grants.rows.map(x=>x.r+':'+x.ok),['anon:false','authenticated:false','service_role:true']);
 report.checks.push('execute stays service_role only');
}
