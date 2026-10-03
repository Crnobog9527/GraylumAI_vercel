/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount,fixture as v1Fixture} from '../erasure-b2a/cases.mjs';

const scalar = async (db,sql,args) => (await db.query(sql,args)).rows[0].v;
const wallet = (db,f) => scalar(db,'SELECT credits v FROM profiles WHERE id=$1',[f.actor]);
const bind = (db,f) => scalar(db,'SELECT b2a_test.bind($1) v',[f]);
const ledger = async (db,f) => (await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[f.actor])).rows;

export async function erasureCases(db, report, createFixture, claim, receipt) {
  const zero = await createFixture(db);
  const ze = await bind(db,zero);
  await closeAccount(db,zero);
  const before = await ledger(db,zero);
  await rpc(db,'runtime_financial_recovery',zero.actor,ze,true);
  assert.deepEqual(await ledger(db,zero),before,'zero call creates no refund');
  assert.equal(await wallet(db,zero),100);
  report.checks.push('erased v2 zero-call run terminates without creating a refund');

  const fresh = await createFixture(db);
  const e = await bind(db,fresh);
  const c = await claim(db,fresh,1,true);
  const held = await wallet(db,fresh);
  assert.ok(held<100);
  // Fixture transport is never called; adapt only provider/protocol to exercise the exact existing proof path.
  await db.query("UPDATE bill2_calls SET provider='openrouter',payload=jsonb_set(payload,'{protocol}','\"openrouter-chat-v1\"') WHERE id=$1",[c.id]);
  await closeAccount(db,fresh);
  const revoke = (token=c.dispatchToken,hash=fresh.claimPayload.requestHash,inspect=false) =>
    rpc(db,'bill2_revoke_unstarted_dispatch',fresh.actor,fresh.run,c.id,token,hash,inspect);
  await assert.rejects(revoke(randomUUID()),/UNSTARTED_DISPATCH_DENIED/);
  await assert.rejects(revoke(c.dispatchToken,'0'.repeat(64)),/UNSTARTED_DISPATCH_DENIED/);
  assert.equal((await revoke(c.dispatchToken,fresh.claimPayload.requestHash,true)).eligible,true);
  assert.equal((await revoke()).revoked,true);
  assert.equal(await wallet(db,fresh),100);
  const settled = await ledger(db,fresh);
  assert.equal((await revoke()).revoked,true);
  await rpc(db,'runtime_financial_recovery',fresh.actor,e,true);
  assert.deepEqual(await ledger(db,fresh),settled,'unstarted proof releases exactly once');
  assert.equal(await wallet(db,fresh),100);
  report.checks.push('erased v2 unstarted dispatch: exact proof required, call hold released exactly once');

  const pending = await createFixture(db);
  const pe = await bind(db,pending);
  const pc = await claim(db,pending,1,true);
  await receipt(db,pending,pc,null);
  const pendingBalance = await wallet(db,pending);
  await closeAccount(db,pending);
  await rpc(db,'runtime_financial_recovery',pending.actor,pe,true);
  const run = await rpc(db,'bill2_read',pending.actor,pending.run);
  assert.equal(run.state,'cost_pending');
  assert.equal(await wallet(db,pending),pendingBalance,'unknown dispatched cost retains hold');
  await rpc(db,'runtime_financial_recovery',pending.actor,pe,true);
  assert.equal(await wallet(db,pending),pendingBalance);
  await assert.rejects(claim(db,pending,2,false),/ACTOR_DENIED|DISPATCH_CLOSED/);
  report.checks.push('erased v2 dispatched unknown: cost_pending retains hold and prevents future calls');

  for (const binding of ['missing','wrong_actor']) {
    const broken = await createFixture(db);
    const bc = await claim(db,broken,1,true);
    await closeAccount(db,broken);
    const original = (await db.query('SELECT pre_deduct_id,reserved_credits FROM bill2_calls WHERE id=$1',[bc.id])).rows[0];
    const old = await v1Fixture(db);
    if (binding==='missing') {
      await db.query('UPDATE bill2_calls SET pre_deduct_id=NULL,reserved_credits=NULL WHERE id=$1',[bc.id]);
    } else {
      await db.query('UPDATE bill2_calls SET pre_deduct_id=$2 WHERE id=$1',[bc.id,old.pre]);
    }
    const before = await wallet(db,broken);
    await assert.rejects(rpc(db,'bill2_finalize',broken.actor,broken.run),/BINDING_DENIED/);
    assert.equal(await wallet(db,broken),before);
    await db.query('UPDATE bill2_calls SET pre_deduct_id=$2,reserved_credits=$3 WHERE id=$1',
      [bc.id,original.pre_deduct_id,original.reserved_credits]);
  }
  report.checks.push('erased v2 missing and cross-actor pre-deduction bindings refuse financial recovery');

  const prefix = await createFixture(db);
  const px = await bind(db,prefix);
  const first = await claim(db,prefix,1,true);
  await receipt(db,prefix,first,'0.001',{inputTokens:1000,outputTokens:0});
  const known = (await db.query('SELECT charged_delta,settled_at FROM bill2_calls WHERE id=$1',[first.id])).rows[0];
  assert.ok(known.settled_at);
  const second = await claim(db,prefix,2,true);
  await receipt(db,prefix,second,null);
  const prefixBalance = await wallet(db,prefix);
  await closeAccount(db,prefix);
  await rpc(db,'runtime_financial_recovery',prefix.actor,px,true);
  assert.equal(await wallet(db,prefix),prefixBalance);
  assert.deepEqual((await db.query('SELECT charged_delta,settled_at FROM bill2_calls WHERE id=$1',[first.id])).rows[0],known);
  report.checks.push('erased v2 known prefix plus unknown suffix preserves settled prefix and remaining hold');
}
