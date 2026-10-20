/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {safetyCases} from './safety.mjs';

// The caller creates both subscriptions through the real checkout/fulfillment/upgrade RPCs.
// Every destructive scenario below is confined to a disposable local database.
export async function overlapCases({admin,service,connect,user,proSub,goldSub,goldOrder,proOrder,proCycle}) {
  const credits = async () => (await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits;
  const grants = async () => (await admin.query(`SELECT subscription_id,consumed_amount FROM subscription_credit_grants
    WHERE user_id=$1 ORDER BY subscription_id`,[user])).rows;
  const facts = async () => (await service.query('SELECT pay_common_membership_facts($1) v',[user])).rows[0].v.internal_membership;
  const pre = (db,n,request=randomUUID()) => db.query('SELECT * FROM atomic_pre_deduct($1,$2,$3,$4)',
    [user,n,'Upgrade overlap regression',request]);
  const restore = id => service.query('SELECT * FROM atomic_refund($1,$2,$3)',[user,id,'Fixture failure']);
  const before = await credits();
  assert.equal((await facts()).id,goldSub);
  const first = (await pre(service,20)).rows[0];
  assert.equal(await credits(),before-20);
  const charged = (await admin.query('SELECT metadata FROM billing_history WHERE id=$1',[first.pre_deduct_id])).rows[0].metadata;
  assert.equal(charged.chargedGrantId,(await admin.query(
    'SELECT id FROM subscription_credit_grants WHERE subscription_id=$1',[goldSub])).rows[0].id);
  assert.equal((await grants()).find(g=>g.subscription_id===proSub).consumed_amount,0);
  await restore(first.pre_deduct_id);
  assert.equal(await credits(),before);
  assert.ok((await grants()).every(g=>g.consumed_amount===0));

  // Spend beyond Gold's current grant: the retained Pro credits are accounted to their original source.
  const crossing = (await pre(service,9000)).rows[0];
  assert.deepEqual((await grants()).map(g=>g.consumed_amount).sort((a,b)=>a-b),[30,8970]);
  await restore(crossing.pre_deduct_id);
  await assert.rejects(restore(crossing.pre_deduct_id),/该预扣记录已处理/);
  assert.equal(await credits(),before);
  assert.ok((await grants()).every(g=>g.consumed_amount===0),'failure restores each source once');

  // Real BILL2 PAYG entry point, not just the primitive that used to throw.
  const f=await createFixture(admin,{actor:user});
  const one=await connect(),two=await connect();
  for(const db of [admin,one,two]) await db.query('SELECT set_config($1,$2,false)',[
    'request.jwt.claim.sub',user,
  ]);
  const claims=await Promise.all([claim(one,f,1,false),claim(two,f,1,false)]);
  assert.equal(claims[0].id,claims[1].id,'concurrent retries reserve once');
  assert.equal(claims.filter(c=>c.dispatchToken).length,1);
  const call=(await admin.query('SELECT reserved_credits,pre_deduct_id FROM bill2_calls WHERE id=$1',[claims[0].id])).rows[0];
  assert.equal(await credits(),before-call.reserved_credits);
  await rpc(admin,'bill2_dispatch',user,f.run,claims[0].id,claims.find(c=>c.dispatchToken).dispatchToken);
  await receipt(admin,f,claims[0],'0.003',{inputTokens:3000,outputTokens:0});
  await rpc(admin,'bill2_close',user,f.run,'confirmed_failure',{
    kind:'confirmed_delivery_failure',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:'fixture failure',
  });
  await rpc(admin,'bill2_finalize',user,f.run);
  await rpc(admin,'bill2_finalize',user,f.run);
  assert.equal(await credits(),before);
  assert.ok((await grants()).every(g=>g.consumed_amount===0));

  // Exercise the actual profile-cap gate. The intentionally absent registration is reached only
  // below the cap; no workflow fixture or unrelated positioning content is needed.
  const cap = async (n,tier='gold') => {
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT set_config($1,$2,true)',[
        'request.jwt.claims',JSON.stringify({sub:user,role:'authenticated'}),
      ]);
      await admin.query(`INSERT INTO opc_businesses(actor_id,name)
        SELECT $1,'Local cap fixture' FROM generate_series(1,$2::int)`,[user,n]);
      await assert.rejects(admin.query(`SELECT opc_start_b1($1,$2,'missing-overlap-fixture','manual',NULL,'test',$3)`,
        [user,randomUUID(),tier]),n>=({free:1,pro:3,gold:6}[tier])?/^error: OPC_PROFILE_LIMIT$/:/^error: OPC_REGISTRATION$/);
    } finally { await admin.query('ROLLBACK'); }
  };
  for(const count of [1,3,5,6]) await cap(count);
  const safety=await safetyCases({admin,user,proSub,goldSub,proOrder,proCycle,pre});

  // The old Pro being ended by a delayed provider event must not revoke Gold or its retained credits.
  await admin.query("UPDATE user_subscriptions SET status='canceled' WHERE id=$1",[proSub]);
  assert.equal((await facts()).membership_level,'gold');
  const ended=(await pre(service,9000)).rows[0];
  await restore(ended.pre_deduct_id);
  assert.equal(await credits(),before);
  await cap(5);
  await admin.query("UPDATE user_subscriptions SET status='active' WHERE id=$1",[proSub]);

  // An external full Gold refund is a real supported downgrade to the still-paid, stopped Pro.
  await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,0)`,[goldOrder.id,`in_${goldOrder.id}`]);
  const refunded=(await service.query(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',$5) v`,
    [goldOrder.id,`in_${goldOrder.id}`,'re_overlap_'+goldOrder.id.replaceAll('-',''),goldOrder.amount_total,new Date()])).rows[0].v;
  assert.equal(refunded.state,'refunded');
  assert.equal((await facts()).membership_level,'pro');
  assert.equal(await credits(),3480);
  await cap(2,'pro');
  await cap(3,'pro');
  const downgraded=(await pre(service,20)).rows[0];
  await restore(downgraded.pre_deduct_id);
  assert.equal(await credits(),3480);
  return ['overlap-gold-primary','overlap-retains-pro-credits','overlap-failure-restores-both-sources',
    'overlap-concurrent-bill2-claim-once','overlap-bill2-failure-compensation','overlap-gold-profile-cap-six',
    'overlap-ended-pro-keeps-gold','overlap-gold-refund-restores-pro-cap-three',...safety];
}
