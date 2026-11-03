/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-12 B-rewrites (migration 0490): the functions that stay after batch F but named an old-path object. Each case runs the
// function as it was before 0490 (b-rewrite-old.sql, turn_test.old_*) and the new one on the same rows and compares what the live
// callers see, then checks the documented differences.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {read} from '../runtime-view-perf/local-db.mjs';

export async function bRewriteCases({c,db,one,account,open,refusal,peer,report}){
 db.sql(read('packages/db/tests/turn-core/b-rewrite-old.sql'));
 const source=a=>one('select turn_test.topic_source($1) v',[a.actor]);
 const resultRow=async(a,session,over={})=>{
  const id=randomUUID();
  await c.query(`insert into runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,request_id,source_turn_id)
   values($1,$2,$3,$1,1,'script','title','body',$4,$5)`,[id,a.actor,session,randomUUID(),over.turn??null]);
  return id;
 };
 // 1. runtime_session_result_view (and the turn view over it): the same json as before for rows with no old source; the four
 // service functions that use it answer as before.
 {
  const a=await account(1000),sid=randomUUID();
  // The service functions read a plain positioning conversation (not a draft's or a topic workspace's).
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [sid,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const plain=await resultRow(a,sid);
  const fromTurn=await resultRow(a,sid,{turn:987654321});
  for(const id of [plain,fromTurn]){
   const both=(await c.query(`select runtime_session_result_view(r,1) n,turn_test.old_runtime_session_result_view(r,1) o
    from runtime_session_results r where r.id=$1`,[id])).rows[0];
   assert.deepEqual(both.n,both.o);
   assert.equal(both.n.sourceAvailable,true);
  }
  const turnView=(await c.query(`select runtime_session_result_turn_view(r,1) v from runtime_session_results r where r.id=$1`,[fromTurn])).rows[0].v;
  assert.equal(turnView.sourceTurnId,987654321);
  assert.equal(turnView.sourceAvailable,false,'a turn whose reply is gone: the folder says the source is gone');
  const list=await one('select runtime_session_results_list_turns($1,$2) v',[a.actor,sid]);
  assert.equal(list.length,2);
  const versions=await one('select runtime_session_result_versions($1,$2) v',[a.actor,plain]);
  assert.equal(versions.length,1);
  assert.equal(versions[0].sourceAvailable,true);
  report.checks.push('B-rewrite runtime_session_result_view: the same json as before for results with no old source; a turn-sourced result keeps the turn view\'s answer; list_turns and versions answer through it');
 }
 // 2. runtime_positioning_gate: refusals are counted on the turns refused for it, the same number turn_open returns.
 {
  const a=await account(1000);
  const before=await one('select runtime_positioning_gate($1) v',[a.actor]);
  assert.deepEqual(before,await one('select turn_test.old_runtime_positioning_gate($1) v',[a.actor]),'no refusal yet: as before');
  const first=await open(a);
  assert.deepEqual(first.positioning,{positioned:false,refusals24h:0});
  await c.query("select turn_close($1,$2,'failed','[]',false,true,'positioning_required')",[a.actor,first.turnId]);
  const after=await one('select runtime_positioning_gate($1) v',[a.actor]);
  assert.deepEqual(after,{positioned:false,refusals24h:1});
  assert.deepEqual((await open(a)).positioning,after,'the gate and turn_open count the same refusals');
  report.checks.push('B-rewrite runtime_positioning_gate: equal to the old answer when nothing was refused; a refused turn counts once, the number turn_open returns');
 }
 // 3. runtime_test_actor_access: the window list decides; the old "ran in a window once" branch is gone.
 {
  const a=await account(1000),b=await account(1000);
  assert.match(await refusal(c.query('select runtime_test_actor_access($1)',[a.actor])),/RUNTIME_TEST_ACTOR_DENIED/);
  assert.match(await refusal(c.query('select turn_test.old_runtime_test_actor_access($1)',[a.actor])),/RUNTIME_TEST_ACTOR_DENIED/);
  await c.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at)
   values($1,true,$2,'[{"model":"fixture"}]',1000,1,10,10,now()+interval '1 hour')`,[randomUUID(),[a.actor]]);
  assert.equal(await one('select runtime_test_actor_access($1) v',[a.actor]),true);
  assert.equal(await one('select turn_test.old_runtime_test_actor_access($1) v',[a.actor]),true);
  assert.match(await refusal(c.query('select runtime_test_actor_access($1)',[b.actor])),/RUNTIME_TEST_ACTOR_DENIED/);
  report.checks.push('B-rewrite runtime_test_actor_access: listed in a window is allowed, anyone else refused, as before (the old-run branch is gone)');
 }
 // 4. fusion_review_fee_settle: a review has no fee row on the turn path; NULL as before.
 {
  const a=await account(1000);
  const review=randomUUID();
  const neu=await one('select fusion_review_fee_settle($1,$2) v',[a.actor,review]);
  assert.equal(neu,null);
  assert.equal(neu,await one('select turn_test.old_fusion_review_fee_settle($1,$2) v',[a.actor,review]));
  report.checks.push('B-rewrite fusion_review_fee_settle: NULL for a review without a fee row, as before');
 }
 // 5. opc_capture_apply: an empty batch for a draft with nothing to capture; the refusals are unchanged.
 {
  const a=await account(1000),src=await source(a),stranger=await account(1000);
  const neu=await one('select opc_capture_apply($1,$2,null) v',[a.actor,src.draft]);
  assert.deepEqual(neu,{processed:[],remaining:0,hasMore:false});
  assert.deepEqual(neu,await one('select turn_test.old_opc_capture_apply($1,$2,null) v',[a.actor,src.draft]),'the same empty batch as before');
  assert.match(await refusal(c.query('select opc_capture_apply($1,$2,null)',[stranger.actor,src.draft])),/OPC_CAPTURE_DENIED/);
  assert.match(await refusal(c.query('select turn_test.old_opc_capture_apply($1,$2,null)',[stranger.actor,src.draft])),/OPC_CAPTURE_DENIED/);
  assert.match(await refusal(c.query('select opc_capture_apply($1,$2,$3)',[a.actor,src.draft,randomUUID()])),/OPC_CAPTURE_DENIED/);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[src.business]);
  assert.match(await refusal(c.query('select opc_capture_apply($1,$2,null)',[a.actor,src.draft])),/OPC_BUSINESS_ARCHIVED/);
  await c.query('update opc_businesses set archived_at=null where id=$1',[src.business]);
  report.checks.push('B-rewrite opc_capture_apply: the same empty batch as before for a draft with nothing to capture; a stranger, an execution id and an archived business are refused');
 }
 // 6. fusion_review_start (replay only) and fusion_review_archive_reconcile (no money left to settle).
 {
  const a=await account(1000),src=await source(a);
  const reviewId=randomUUID(),request=randomUUID();
  await c.query(`insert into fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
   materials,materials_hash,config,state,round,phase,attempt) values($1,$2,$3,$4,$5,$6,$7,'h','{}',repeat('a',64),'{"maxRounds":2,"path":"turn"}','running',1,'review',1)`,
   [reviewId,a.actor,request,src.draft,src.project,src.session,src.version]);
  const replay=await one('select fusion_review_start($1,$2,$3,$4,$5) v',[a.actor,request,src.draft,src.version,'{}']);
  assert.equal(replay.reviewId??replay.id,reviewId,'a known request returns its review');
  assert.match(await refusal(c.query('select fusion_review_start($1,$2,$3,$4,$5)',[a.actor,randomUUID(),src.draft,src.version,'{}'])),/FUSION_REVIEW_INVALID/);
  assert.match(await refusal(c.query('select fusion_review_start($1,$2,$3,$4,$5)',
   [a.actor,randomUUID(),src.draft,src.version,JSON.stringify({estimateUsd:'0.1'})])),/FUSION_REVIEW_INVALID/,'no new review through the old fee path');
  assert.match(await refusal(c.query('select fusion_review_start($1,$2,$3,$4,$5)',[a.actor,request,src.draft,randomUUID(),'{}'])),/FUSION_REVIEW_CONFLICT/);
  // reconcile: not archived -> false and nothing changes; archived -> the running review ends as incomplete (source_archived)
  assert.equal(await one('select fusion_review_archive_reconcile($1,$2) v',[a.actor,JSON.stringify({draftId:src.draft})]),false);
  assert.equal((await c.query('select state from fusion_reviews where id=$1',[reviewId])).rows[0].state,'running');
  // The archive trigger refuses while a review runs, so the review ends for the archiving and runs again after it (the state a
  // review created before the business was archived can be left in).
  await c.query("update fusion_reviews set state='completed',ended_at=now() where id=$1",[reviewId]);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[src.business]);
  await c.query("update fusion_reviews set state='running',ended_at=null where id=$1",[reviewId]);
  assert.equal(await one('select fusion_review_archive_reconcile($1,$2) v',[a.actor,JSON.stringify({reviewId})]),true);
  const ended=(await c.query('select state,outcome,ended_at from fusion_reviews where id=$1',[reviewId])).rows[0];
  assert.equal(ended.state,'incomplete');
  assert.deepEqual(ended.outcome,{kind:'source_archived'});
  assert.ok(ended.ended_at);
  const replayed=await one('select fusion_review_start($1,$2,$3,$4,$5) v',[a.actor,request,src.draft,src.version,'{}']);
  assert.equal(replayed.reviewId??replayed.id,reviewId,'a replay of the archived business\'s review still answers');
  await c.query('update opc_businesses set archived_at=null where id=$1',[src.business]);
  report.checks.push('B-rewrite fusion_review_start / fusion_review_archive_reconcile: a known request replays (also after archiving), anything else is invalid or a conflict; an archived business ends its running review as incomplete (source_archived)');
 }
 // 7. opc_capture_apply keeps its lock order: it waits for a writer holding the project row (as the old function did before any read of
 // an execution), and goes on when the writer commits.
 {
  const a=await account(1000),src=await source(a),writer=await peer();
  try{
   await writer.query('begin');
   await writer.query('select 1 from artifact_projects where id=$1 for update',[src.project]);
   let done=false;
   const pending=one('select opc_capture_apply($1,$2,null) v',[a.actor,src.draft]).then(v=>{done=true;return v;});
   await new Promise(r=>setTimeout(r,500));
   assert.equal(done,false,'the capture waits for the project lock');
   await writer.query('commit');
   assert.deepEqual(await pending,{processed:[],remaining:0,hasMore:false});
  }finally{await writer.end();}
  report.checks.push('B-rewrite opc_capture_apply: still takes the draft session row, then the project row, and waits for a writer that holds the project');
 }
 // 8. The migration refuses to run while an old review fee is still held (batch F drops the table; a freeze must not vanish with it).
 {
  const a=await account(1000);
  const migration=read('packages/db/migrations/0490_core_path_v2_old_path_function_rewrites.sql');
  const review=randomUUID();
  await c.query("insert into fusion_review_fees(review_id,actor_id,credits,pre_deduct_id,state) values($1,$2,100,$3,'held')",[review,a.actor,randomUUID()]);
  try{
   assert.match(await refusal(c.query(migration)),/V2_12_B_HELD_REVIEW_FEES/);
  }finally{
   await c.query('rollback').catch(()=>{});
   await c.query('delete from fusion_review_fees where review_id=$1',[review]);
  }
  await c.query(migration);   // no held fee left: applies again (repeatable)
  report.checks.push('B-rewrite migration 0490 refuses to run while a review fee is held, and applies again once none is');
 }
}
