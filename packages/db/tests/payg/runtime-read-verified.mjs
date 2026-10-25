/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture} from './fixture.mjs';

/** DB-100 C3 (0384): inside a running reply the two read RPCs skip the lineage walk; deletion, owner and writes stay checked. */
export async function runtimeReadVerifiedCases({db,report,setup}) {
  // Same actor, more admitted executions: the reply's frozen lineage (what runtime_billing_allowed walks).
  const ancestors=async(f,n)=>{
    const turns=[];
    for(let i=0;i<n;i++){
      const g=await createFixture(db,{actor:f.actor,credits:0,threshold:1});
      const s=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:g.payload.scope});
      turns.push({session:s.sessionId,
        execution:(await rpc(db,'runtime_admit',f.actor,s.sessionId,randomUUID(),f.context,{...g.payload,input:f.context})).executionId});
    }
    await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) SELECT $1,unnest($2::uuid[])',
      [f.execution,turns.map(t=>t.execution)]);
    return turns;
  };
  // One read in its own transaction: answer, lineage checks made, and whether it took a transaction id (a lock or write).
  const measured=async sql=>{
    await db.query('BEGIN');
    try{
      await db.query("SET LOCAL track_functions='all'");
      // Not-yet-flushed counts of earlier transactions stay in this view, so count the difference.
      const calls=async()=>Number((await db.query("SELECT calls FROM pg_stat_xact_user_functions WHERE funcname='runtime_direct_billing_allowed'")).rows[0]?.calls??0);
      const before=await calls();
      const value=(await db.query(sql.text,sql.args)).rows[0].v;
      const checks=await calls()-before;
      const xid=(await db.query('SELECT txid_current_if_assigned() x')).rows[0].x;
      return {value,checks,xid};
    }finally{await db.query('ROLLBACK');}
  };
  const response=(f,actor=f.actor)=>({text:'SELECT public.runtime_response($1,$2,1,$3) v',args:[actor,f.execution,'b'.repeat(64)]});
  const items=(f,actor=f.actor)=>({text:"SELECT public.runtime_session_items($1,$2,$3,'read') v",args:[actor,f.session,f.execution]});
  const expire=f=>db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run]);
  const append=(f,batch=0)=>rpc(db,'runtime_session_items',f.actor,f.session,f.execution,'append',JSON.stringify([{role:'assistant',content:'synthetic'}]),null,batch);

  // Allowed: same answers as the full path, zero lineage checks, no transaction id; the full path is back once the window ends.
  const f=await setup();await ancestors(f,6);
  await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item,internal_control)
    VALUES($1,1,$2,'{"role":"user","content":"history canary"}',false)`,[f.session,f.execution]);
  await db.query('UPDATE runtime_executions SET candidate_history=ARRAY[1]::bigint[] WHERE id=$1',[f.execution]);
  const fastItems=await measured(items(f)),fastResponse=await measured(response(f));
  assert.deepEqual(fastItems.value,[{revision:1,item:{role:'user',content:'history canary'}}]);
  assert.equal(fastResponse.value,null);
  assert.deepEqual([fastItems.checks,fastItems.xid,fastResponse.checks,fastResponse.xid],[0,null,0,null]);
  await expire(f);
  const fullItems=await measured(items(f)),fullResponse=await measured(response(f));
  assert.deepEqual(fullItems.value,fastItems.value);assert.equal(fullResponse.value,null);
  assert.ok(fullItems.checks>=7&&fullResponse.checks>=7,'full path walks the 6-ancestor lineage');
  assert.notEqual(fullItems.xid,null);assert.notEqual(fullResponse.xid,null);
  report.checks.push('running reply reads skip the lineage walk (0 checks, no lock) with the same answers; expired window walks it again');

  // Denied: another account never reads this execution, inside the window or not.
  const g=await setup(),stranger=await setup();
  await assert.rejects(measured(response(g,stranger.actor)),/RUNTIME_RESPONSE_DENIED/);
  await assert.rejects(measured(items(g,stranger.actor)),/RUNTIME_SESSION_DENIED/);
  // A paused or user-stopped reply is outside the window: full path.
  await db.query("UPDATE bill2_runs SET paused_reason='user_stop' WHERE id=$1",[g.run]);
  assert.ok((await measured(response(g))).checks>=1);
  report.checks.push('another account is refused by both reads; a paused reply reads through the full check');

  // Deleting the conversation is immediate: same-reply reads and writes are refused right away.
  const d=await setup();await ancestors(d,2);
  assert.equal((await rpc(db,'content_erasure_mark_session',d.actor,d.session)).status,'deleted');
  await assert.rejects(measured(response(d)),/CONTENT_ERASED/);
  await assert.rejects(measured(items(d)),/CONTENT_ERASED/);
  await assert.rejects(append(d),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'runtime_execution',d.actor,d.execution,'read',null),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'bill2_claim',d.actor,d.run,1,{...d.claimPayload,runtimeEpoch:1}),/CONTENT_ERASED|RUNTIME_SCOPE_DENIED|BILL2_RUN_DENIED/);
  report.checks.push('deleted conversation: both reads, history append, execution step and the next claim are refused at once');

  // A history turn marked unavailable after admit is left out of the fast read too; the execution itself marked
  // unavailable is outside the window and refused by the full check.
  const h=await setup(),[{execution:turn}]=await ancestors(h,1);
  await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item,internal_control)
    VALUES($1,1,$2,'{"role":"user","content":"revoked canary"}',false)`,[h.session,turn]);
  await db.query('UPDATE runtime_executions SET candidate_history=ARRAY[1]::bigint[] WHERE id=$1',[h.execution]);
  assert.equal((await measured(items(h))).value.length,1);
  await db.query("UPDATE runtime_executions SET unavailable_reason='source_revoked' WHERE id=$1",[turn]);
  const left=await measured(items(h));
  assert.deepEqual([left.value,left.checks],[[],0]);
  await assert.rejects(append(h),/RUNTIME_HISTORY_UNAVAILABLE/);
  await assert.rejects(rpc(db,'bill2_claim',h.actor,h.run,1,{...h.claimPayload,runtimeEpoch:1}),/RUNTIME_HISTORY_UNAVAILABLE/);
  await db.query("UPDATE runtime_executions SET unavailable_reason='source_revoked' WHERE id=$1",[h.execution]);
  await assert.rejects(measured(items(h)),/RUNTIME_HISTORY_UNAVAILABLE/);
  report.checks.push('history turn made unavailable mid-reply: left out of the fast read, next append and claim refused; unavailable execution refused');

  // A deeper permission change mid-reply: reads in the window keep serving (Owner boundary), every write is refused,
  // and the reads refuse too once the window ends.
  const r=await setup();await ancestors(r,2);
  await db.query("UPDATE ai_models SET is_active='false' WHERE id=$1",[r.payload.modelId]);
  try{
    assert.equal((await measured(response(r))).checks,0);
    await assert.rejects(append(r),/BILL2_CALL_POLICY_DENIED/);
    await assert.rejects(rpc(db,'runtime_execution',r.actor,r.execution,'read',null),/BILL2_CALL_POLICY_DENIED|RUNTIME_CONTEXT_REVOKED/);
    await assert.rejects(rpc(db,'bill2_claim',r.actor,r.run,1,{...r.claimPayload,runtimeEpoch:1}),/BILL2_CALL_POLICY_DENIED/);
    await expire(r);
    await assert.rejects(measured(response(r)),/BILL2_CALL_POLICY_DENIED/);
    await assert.rejects(measured(items(r)),/BILL2_CALL_POLICY_DENIED/);
  }finally{await db.query("UPDATE ai_models SET is_active='true' WHERE id=$1",[r.payload.modelId]);}
  report.checks.push('permission revoked mid-reply: window reads serve, append/execution/claim are refused, reads refuse after the window');

  // Each way out of the window goes back to the full check: allowed when everything is still permitted, refused once
  // the reply's model permission is revoked.
  const exits={
    expired:expire,
    notActive:f=>db.query('UPDATE runtime_sessions SET active_execution=NULL WHERE id=$1',[f.session]),
    runClosed:f=>db.query('UPDATE bill2_runs SET closed=true WHERE id=$1',[f.run]),
  };
  for(const [name,leave] of Object.entries(exits)){
    const x=await setup();await ancestors(x,2);await leave(x);
    const allowed=await measured(response(x));
    assert.equal(allowed.value,null,name);assert.ok(allowed.checks>=3,`${name}: full lineage check`);
    assert.ok((await measured(items(x))).checks>=3,`${name}: full lineage check on history read`);
    await db.query("UPDATE ai_models SET is_active='false' WHERE id=$1",[x.payload.modelId]);
    try{
      await assert.rejects(measured(response(x)),/BILL2_CALL_POLICY_DENIED/,name);
      await assert.rejects(measured(items(x)),/BILL2_CALL_POLICY_DENIED/,name);
    }finally{await db.query("UPDATE ai_models SET is_active='true' WHERE id=$1",[x.payload.modelId]);}
  }
  report.checks.push('expired window, not the active execution, closed run: each reads through the full check (allowed and refused)');

  // An ancestor's conversation deleted while this reply runs: the deletion also covers this reply, which holds a copy
  // of that history, so its reads and every next write are refused at once.
  const a=await setup(),[gone]=await ancestors(a,2);
  assert.equal((await rpc(db,'content_erasure_mark_session',a.actor,gone.session)).status,'deleted');
  await assert.rejects(measured(response(a)),/CONTENT_ERASED/);
  await assert.rejects(measured(items(a)),/CONTENT_ERASED/);
  await assert.rejects(append(a),/CONTENT_ERASED|RUNTIME_HISTORY_UNAVAILABLE/);
  await assert.rejects(rpc(db,'runtime_execution',a.actor,a.execution,'read',null),/CONTENT_ERASED|RUNTIME_CONTEXT_REVOKED/);
  await assert.rejects(rpc(db,'bill2_claim',a.actor,a.run,1,{...a.claimPayload,runtimeEpoch:1}),/CONTENT_ERASED|RUNTIME_HISTORY_UNAVAILABLE/);
  report.checks.push('ancestor conversation deleted mid-reply: both reads, next append, execution step and claim are refused at once');
}
