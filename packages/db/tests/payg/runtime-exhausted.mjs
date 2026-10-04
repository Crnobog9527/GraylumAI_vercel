/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

export async function runtimeExhaustedCases({db,Client,connectionString,report,setup}) {
  const f=await setup({},1);
  await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
  const call={...f.claimPayload,runtimeEpoch:1};
  const c=await rpc(db,'bill2_claim',f.actor,f.run,1,call);
  // Last allowed call was claimed but transport never started. The real wait
  // authority retires it, refunds its hold, and still counts its sequence.
  const wait=await rpc(db,'runtime_execution',f.actor,f.execution,'payg_wait',{
    epoch:1,state:'waiting_resume',sequence:1,requestHash:call.requestHash,phase:call.phase,
  });
  assert.equal(wait.remainingCalls,0);
  assert.equal(wait.state,'waiting_resume');
  const facts=async()=>(await db.query(`SELECT
    (SELECT to_jsonb(c) FROM bill2_calls c WHERE id=$1) call,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM credit_transactions t WHERE user_id=$2) ledger`,[c.id,f.actor])).rows[0];
  const before=await facts();
  assert.equal(before.call.state,'cancelled');
  assert.equal(before.call.dispatched_at,null);
  assert.ok(before.call.settled_at);
  for(const token of [{epoch:2,cursor:1},{epoch:1,cursor:2}])
    await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',token),/RESUME_CONFLICT/);
  const other=new Client({connectionString});
  await other.connect();
  try {
    const race=await Promise.allSettled([db,other].map(client=>
      rpc(client,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:1,cursor:1})));
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(race.find(r=>r.status==='fulfilled').value.state,'cancelled');
    assert.match(String(race.find(r=>r.status==='rejected').reason),/RESUME_CLOSED/);
  } finally {await other.end();}
  assert.deepEqual(await facts(),before);
  const terminal=await rpc(db,'runtime_execution',f.actor,f.execution,'read',null);
  assert.equal(terminal.cancelRequested,true);
  assert.equal((await db.query('SELECT active_execution FROM runtime_sessions WHERE id=$1',[f.session])).rows[0].active_execution,null);
  const next=await rpc(db,'runtime_admit',f.actor,f.session,randomUUID(),f.context,f.payload);
  assert.notEqual(next.executionId,f.execution);
  assert.deepEqual(await facts(),before);
  report.checks.push('exhausted pre-transport waiter cancels through original CAS; stale/concurrent resumes rejected, no extra refund, new admission unblocked');
}
