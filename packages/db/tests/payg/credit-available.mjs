/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P4 (0399): credit_available is the one formula for spendable credits; bill2_payg_claim and atomic_pre_deduct
// both call it. Each hold kind is covered on the claim and pre-deduct paths by quarantine.mjs and refund-hold.mjs;
// these cases check the shared value, the two spots where the old copies differed (dispute-frozen grants), a repeated
// claim and two concurrent claims against held credits.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {terminatedGrant} from './quarantine.mjs';

const available=async(db,actor)=>(await db.query('SELECT credit_available($1) n',[actor])).rows[0].n;
const balance=async(db,actor)=>(await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const preDeduct=(db,actor,amount)=>db.query("SELECT * FROM atomic_pre_deduct($1,$2,'local',$3)",[actor,amount,randomUUID()]);
// Fixture only: freeze a grant the way pay_dispute_freeze leaves it (its remainder taken out of the balance), without
// running the dispute flow, which is not under test here.
async function freeze(db,actor,frozenCredits) {
  await db.query('SET session_replication_role=replica');
  try {
    await db.query('UPDATE subscription_credit_grants SET dispute_frozen=true,dispute_frozen_credits=$2 WHERE user_id=$1',
      [actor,frozenCredits]);
    await db.query('UPDATE profiles SET credits=credits-$2 WHERE id=$1',[actor,frozenCredits]);
  } finally { await db.query('SET session_replication_role=origin'); }
}

export async function creditAvailableCases({db,Client,connectionString,report,createFixture,claim}) {
  // Value: balance minus the quarantined remainder; not clamped at zero.
  const part=await createFixture(db);
  await terminatedGrant(db,part.actor,{credits:40});
  assert.equal(await available(db,part.actor),60);
  const over=await createFixture(db);
  await terminatedGrant(db,over.actor,{credits:150});
  assert.equal(await available(db,over.actor),-50,'negative, callers clamp');
  assert.equal((await claim(db,over,1,false)).state,'waiting_credits');
  await assert.rejects(preDeduct(db,over.actor,1),/PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/);
  assert.equal(await balance(db,over.actor),100,'failed paths change nothing');

  // Normal claim, then the same claim again: one call, reserved against credit_available.
  const c=await claim(db,part,1,false);
  assert.ok(c.id);
  const row=(await db.query('SELECT available_credits,reserved_credits FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.equal(row.available_credits,60);
  assert.equal((await claim(db,part,1,false)).id,c.id,'repeated claim returns the same call');
  assert.equal(await balance(db,part.actor),100-row.reserved_credits,'reserved once');

  // A dispute-frozen grant of a terminated subscription: its remainder has already left the balance, so it is not held
  // a second time (the claim used to subtract it again and saw 20 here).
  const frozen=await createFixture(db);
  await terminatedGrant(db,frozen.actor,{credits:40});
  await freeze(db,frozen.actor,40);
  assert.equal(await available(db,frozen.actor),60);
  const fc=await claim(db,frozen,1,false);
  assert.equal((await db.query('SELECT available_credits FROM bill2_calls WHERE id=$1',[fc.id])).rows[0].available_credits,60);
  // Part of the frozen remainder still in the balance (in-flight) is held by pay_dispute_pending_hold.
  const inflight=await createFixture(db);
  await terminatedGrant(db,inflight.actor,{credits:40,terminated:false});
  await freeze(db,inflight.actor,30);
  assert.equal(await available(db,inflight.actor),70-10);

  // Review barrier on both paths, also for a frozen grant (pre-deduct used to skip frozen grants here).
  for (const frozenGrant of [false,true]) {
    const f=await createFixture(db);
    await terminatedGrant(db,f.actor,{credits:10,terminated:false});
    if (frozenGrant) await freeze(db,f.actor,10);
    await db.query("UPDATE subscription_credit_grants SET accounting_state='review_required' WHERE user_id=$1",[f.actor]);
    const before=await balance(db,f.actor);
    await assert.rejects(claim(db,f,1,false),/PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED/,'claim frozen='+frozenGrant);
    await assert.rejects(preDeduct(db,f.actor,1),/PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED/,'pre-deduct frozen='+frozenGrant);
    assert.equal(await balance(db,f.actor),before);
  }

  // Concurrency: two runs of one account claim at once; together they never reserve the held 60 credits.
  const a=await createFixture(db);
  const b=await createFixture(db,{actor:a.actor});
  await terminatedGrant(db,a.actor,{credits:60});
  const clients=[new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(x=>x.connect()));
  try { await Promise.all([[clients[0],a],[clients[1],b]].map(([x,f])=>claim(x,f,1,false))); }
  finally { await Promise.all(clients.map(x=>x.end())); }
  const reserved=(await db.query('SELECT coalesce(sum(reserved_credits),0)::int n FROM bill2_calls WHERE run_id=ANY($1)',
    [[a.run,b.run]])).rows[0].n;
  assert.ok(reserved>0&&reserved<=40,'reserved '+reserved);
  assert.ok(await balance(db,a.actor)>=60,'the held remainder stays in the balance');
  report.checks.push('MAINT-P4 credit_available: value and negative result; claim/pre-deduct share it; repeat claim once; '
    +'dispute-frozen terminated grant not held twice; in-flight dispute hold; review barrier on both paths incl. frozen grants; '
    +'concurrent claims never reserve held credits');
}
