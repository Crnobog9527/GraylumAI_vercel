/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount,fixture as v1Fixture} from '../erasure-b2a/cases.mjs';
import {claim,receipt} from './fixture.mjs';

/** Uses real PAYG admission/waiting and the existing service-only erasure inventory. */
export async function runtimeErasureCases({db,report,setup}) {
  const ledger=async f=>(await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[f.actor])).rows;
  const balance=async f=>(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
  const finish=f=>rpc(db,'runtime_financial_recovery',f.actor,f.execution,true);
  const wait=async(f,state='waiting_credits',sequence=1)=>rpc(db,'runtime_execution',f.actor,f.execution,'payg_wait',{
    epoch:1,state,sequence,requestHash:f.claimPayload.requestHash,phase:f.claimPayload.phase,
  });
  for(const state of ['waiting_credits','waiting_resume']){
    const f=await setup();await wait(f,state);await closeAccount(db,f);
    const before=await ledger(f);
    const batch=await rpc(db,'account_erasure_financial_batch',20,f.actor,null);
    assert.ok(batch.items.some(i=>i.executionId===f.execution&&i.executionState===state));
    const read=await rpc(db,'runtime_financial_recovery',f.actor,f.execution,false);
    assert.equal(read.billing.accountClosed,true);assert.equal(read.state,state);
    assert.equal((await finish(f)).state,'cancelled');assert.equal((await finish(f)).state,'cancelled');
    assert.deepEqual(await ledger(f),before);assert.equal(await balance(f),0);
    assert.equal((await rpc(db,'account_erasure_financial_batch',20,f.actor,null)).totalPending,0);
    await assert.rejects(rpc(db,'runtime_financial_recovery',randomUUID(),f.execution,true),/EXECUTION_DENIED/);
  }
  report.checks.push('erased zero-call waiting states selected by existing batch, close idempotently without refund or Auth');
  const prefix=await setup();await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[prefix.actor]);
  const pc=await claim(db,prefix,1,true);await receipt(db,prefix,pc);
  const saved=(await db.query('SELECT * FROM bill2_calls WHERE id=$1',[pc.id])).rows[0];
  await wait(prefix,'waiting_resume',2);await closeAccount(db,prefix);
  const prefixLedger=await ledger(prefix),prefixBalance=await balance(prefix);
  assert.equal((await finish(prefix)).state,'cancelled');await finish(prefix);
  assert.deepEqual((await db.query('SELECT * FROM bill2_calls WHERE id=$1',[pc.id])).rows[0],saved);
  assert.deepEqual(await ledger(prefix),prefixLedger);assert.equal(await balance(prefix),prefixBalance);
  report.checks.push('erased waiting after settled prefix preserves complete call and ledger facts');
  for(const dispatched of [false,true]){
    const f=await setup();await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
    const c=await claim(db,f,1,dispatched),held=await balance(f);
    // Compatibility fixture: a historical/interrupted waiter may retain an unresolved call.
    await db.query("UPDATE runtime_executions SET state='waiting_resume' WHERE id=$1",[f.execution]);
    await closeAccount(db,f);
    const first=await finish(f),after=await ledger(f);await finish(f);
    assert.equal(first.state,dispatched?'cost_pending':'cancelled');
    assert.equal(await balance(f),dispatched?held:100);assert.deepEqual(await ledger(f),after);
    if(dispatched){
      assert.equal((await db.query('SELECT settled_at FROM bill2_calls WHERE id=$1',[c.id])).rows[0].settled_at,null);
      await assert.rejects(claim(db,f,2,false),/ACTOR_DENIED|DISPATCH_CLOSED/);
    }
  }
  report.checks.push('erased historical waiter releases undispatched hold once; unknown dispatched hold remains cost_pending');
  for(const kind of ['missing','foreign']){
    const f=await setup();await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
    const c=await claim(db,f,1,false);await closeAccount(db,f);
    const other=await v1Fixture(db);
    if(kind==='missing')await db.query('UPDATE bill2_calls SET pre_deduct_id=NULL,reserved_credits=NULL WHERE id=$1',[c.id]);
    else await db.query('UPDATE bill2_calls SET pre_deduct_id=$2 WHERE id=$1',[c.id,other.pre]);
    const before=await ledger(f);
    await assert.rejects(finish(f),/BINDING_DENIED/);assert.deepEqual(await ledger(f),before);
  }
  report.checks.push('erased waiting recovery rejects missing and foreign holds without ledger effects');
  const legacy=await v1Fixture(db);
  legacy.execution=(await db.query('SELECT b2a_test.bind($1) v',[legacy])).rows[0].v;
  await closeAccount(db,legacy);
  assert.equal((await finish(legacy)).state,'cancelled');
  const legacyLedger=await ledger(legacy);await finish(legacy);
  assert.deepEqual(await ledger(legacy),legacyLedger);assert.equal(await balance(legacy),100);
  report.checks.push('legacy v1 original run-level hold refund remains idempotent');

}
