/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {addUtcMonths,latestMonthEnd} from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP 3b (0238): renewals, failures, 24-hour grace and state of Stripe card subscriptions. */
export async function stripeMpRenewalCases({admin,service,connect}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const month=(date,n=1)=>addUtcMonths(date,n);
  const year=date=>{const d=new Date(date);d.setUTCFullYear(d.getUTCFullYear()+1);return d;};
  // First period ended two hours ago, so the renewal and the 24-hour grace are both "now".
  const paidFirst=async(method,offer,cycle,digest)=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,'fixture','test',$6,
      'terms-v1',$7) o`,[user,plan,cycle,method,offer,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest}])])).rows[0];
    const expiry=new Date(Date.now()+1800000),checkout=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
    const end=latestMonthEnd(new Date(Math.floor(Date.now()/1000)*1000-2*3600000));
    const start=cycle==='yearly'?new Date(new Date(end).setUTCFullYear(end.getUTCFullYear()-1)):month(end,-1);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
    const fulfilled=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[o.id,'fixture',checkout,
      `in_first_${o.id.slice(0,8)}`,o.amount_total,'usd',new Date(start.getTime()+6000),`sub_${o.id}`,start,cycle==='yearly'?year(start):month(start)])).rows[0].v;
    assert.equal(fulfilled.state,'fulfilled',JSON.stringify(fulfilled));
    return {o,user,sub:fulfilled.subscriptionId,end,cycle};
  };
  const renew=(db,f,{invoice=`in_renew_${f.o.id.slice(0,8)}`,amount=6900,start=f.end,end=f.cycle==='yearly'?year(f.end):month(f.end),
    paid=new Date(f.end.getTime()+60000)}={})=>db.query(`SELECT pay_stripe_mp_renew_subscription($1,'fixture',$2,$3,'usd',$4,$5,$6) v`,
    [f.sub,invoice,amount,paid,start,end]);
  const facts=async user=>(await service.query('SELECT pay_common_membership_facts($1) v',[user])).rows[0].v.internal_membership;
  const sub=async f=>(await admin.query('SELECT status,cancel_at_period_end,founder_failed_at,current_period_end FROM user_subscriptions WHERE id=$1',[f.sub])).rows[0];
  const fail=(f,at,invoice=`in_renew_${f.o.id.slice(0,8)}`)=>service.query(
    `SELECT pay_stripe_mp_record_renewal_failure($1,'fixture',$2,$3) v`,[f.sub,invoice,at]);
  const sync=(f,stop,canceled,userCanceled=false)=>service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',$2,$3,$4) v`,
    [f.sub,stop,canceled,userCanceled]);

  // 24-hour grace for card and card_cn: the renewal is due, still renewing, membership kept (no credits).
  const card=await paidFirst('card','gold_first30','monthly','a1'.repeat(32));
  const cn=await paidFirst('card_cn','standard','monthly','a2'.repeat(32));
  for(const f of [card,cn]) {
    const m=await facts(f.user);
    assert.equal(m.mapping_state,'internal_paid',JSON.stringify(m)); assert.ok(m.renewal_grace_until,'grace applies');
  }
  // A failure is recorded once (Stripe's later retries do not move it) and does not break the grace.
  // Reverse delivery: a later retry processed first, then the original failure; the earliest one wins.
  const failedAt=new Date(card.end.getTime()+3600000);
  await fail(card,new Date(failedAt.getTime()+1800000)); await fail(card,failedAt);
  await fail(card,new Date(failedAt.getTime()+2700000));
  assert.equal((await sub(card)).founder_failed_at.toISOString(),failedAt.toISOString());
  assert.equal((await sub(card)).status,'active','past_due is never copied');
  assert.equal((await facts(card.user)).mapping_state,'internal_paid');
  // Renewal: list price 69 (the first-month coupon is not carried), one grant per invoice.
  await assert.rejects(()=>renew(service,card,{amount:4900}),/RENEW_CONFLICT/,'49 is the first month only');
  await assert.rejects(()=>renew(service,card,{amount:6900+1380}),/RENEW_CONFLICT/,'a tax-inclusive amount is refused');
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const results=await Promise.allSettled([renew(one,card),renew(two,card)]);
  const ok=results.filter(r=>r.status==='fulfilled').map(r=>r.value.rows[0].v);
  assert.equal(ok.filter(v=>v.duplicate===false).length,1,JSON.stringify(results.map(r=>r.reason?.message??r.value.rows[0].v)));
  assert.equal((await renew(service,card)).rows[0].v.duplicate,true,'invoice.paid then invoice.payment_succeeded');
  const renewed=(await admin.query(`SELECT id,amount_total,purchase_snapshot,payment_method,stripe_managed_payments,offer_kind
    FROM payment_orders WHERE subscription_id=$1 AND source_order_id IS NOT NULL`,[card.sub])).rows;
  // The renewal invoice's Managed Payments tax is recorded on the renewal order (0237 pay_stripe_mp_record_tax).
  const renewalTax=()=>service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,1380) v`,[renewed[0].id,`in_renew_${card.o.id.slice(0,8)}`]);
  assert.equal((await renewalTax()).rows[0].v.duplicate,false); assert.equal((await renewalTax()).rows[0].v.duplicate,true);
  assert.equal(renewed.length,1);
  assert.deepEqual([renewed[0].amount_total,renewed[0].purchase_snapshot.price,renewed[0].purchase_snapshot.discount,
    renewed[0].payment_method,renewed[0].stripe_managed_payments,renewed[0].offer_kind],[6900,'69.00','0.00','card',true,'standard']);
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[card.user])).rows[0].credits,8970*2);
  const after=await sub(card);
  assert.equal(after.founder_failed_at,null,'a paid renewal clears the failure');
  assert.equal(after.current_period_end.toISOString(),month(card.end).toISOString(),'next charge date moves forward');
  await assert.rejects(()=>renew(service,card,{invoice:'in_second_same_period'}),/RENEW_CONFLICT/,'one paid order per period');

  // Stop at period end (also set by the buyer on Link) ends the grace; the final cancellation is permanent.
  // Account deletion (0224, any channel): a still-renewing MP subscription blocks it, served by the Stripe portal.
  const erasure=async user=>(await admin.query('SELECT account_erasure_renewing($1) renewing,account_erasure_renewal_channels($1) channels',
    [user])).rows[0];
  assert.deepEqual(await erasure(cn.user),{renewing:true,channels:['stripe_portal']});
  assert.equal((await facts(cn.user)).mapping_state,'internal_paid');
  await sync(cn,true,false);
  assert.deepEqual(await erasure(cn.user),{renewing:false,channels:[]},'stopping renewal in the portal lifts the deletion block');
  assert.deepEqual([(await sub(cn)).status,(await sub(cn)).cancel_at_period_end],['active','true']);
  assert.notEqual((await facts(cn.user)).mapping_state,'internal_paid','a stopped subscription ends at the paid end');
  await sync(cn,false,false);
  assert.equal((await sub(cn)).cancel_at_period_end,'false','resuming before the end clears the stop');
  await sync(cn,false,true); await sync(cn,false,false);
  assert.deepEqual([(await sub(cn)).status,(await sub(cn)).cancel_at_period_end],['canceled','true'],'a late update never reopens');
  assert.equal((await erasure(cn.user)).renewing,false);
  // The cached level returns to free once nothing paid is running, so the buyer can check out again.
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[cn.user])).rows[0].membership_level,'free');
  const again=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card_cn','standard',
    'fixture','test',$3,'terms-v1',$4) o`,[cn.user,plan,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest:'a2'.repeat(32)}])])).rows[0];
  assert.equal(again.payment_status,'unpaid');
  // A member whose paid period is still running keeps the cached level even if another subscription is canceled.
  const keepLevel=(await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[card.user])).rows[0].membership_level;
  assert.equal(keepLevel,'gold');
  // 0243: the final cancellation settles from pay_common_membership_facts; the renewed term already paid
  // keeps running to its end, so the level is kept (no paid time is revoked).
  await sync(card,false,true);
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[card.user])).rows[0].membership_level,'gold');
  assert.equal((await facts(card.user)).mapping_state,'internal_paid');
  // A charge after the final cancellation is kept for review (refund), never granted.
  const cnCredits=(await admin.query('SELECT credits FROM profiles WHERE id=$1',[cn.user])).rows[0].credits;
  assert.equal((await renew(service,cn)).rows[0].v.state,'review');
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[cn.user])).rows[0].credits,cnCredits);

  // Founder card_cn: the 7-day deadline starts at the first renewal failure.
  await admin.query(`UPDATE payment_orders SET qualification_state='released' WHERE id=(SELECT id FROM payment_orders
    WHERE offer_kind='founder' AND qualification_state='reserved' AND payment_mode='test' ORDER BY created_at LIMIT 1)`);
  const founder=await paidFirst('card_cn','founder','yearly','a3'.repeat(32));
  assert.equal((await admin.query('SELECT pay_waffo_founder_deadline($1) v',[founder.o.id])).rows[0].v,null);
  const founderFailed=new Date(founder.end.getTime()+3600000);
  await fail(founder,founderFailed,'in_founder_renew');
  assert.equal((await admin.query('SELECT pay_waffo_founder_deadline($1) v',[founder.o.id])).rows[0].v.toISOString(),
    new Date(founderFailed.getTime()+7*86400000).toISOString());
  const founderRenewal=(await renew(service,founder,{invoice:'in_founder_renew',amount:49600})).rows[0].v;
  assert.equal(founderRenewal.state,'fulfilled');
  assert.equal((await admin.query('SELECT offer_kind FROM payment_orders WHERE id=$1',[founderRenewal.orderId])).rows[0].offer_kind,'founder_renewal');

  // Founder window after a failed renewal: retry exhaustion keeps it; a cancellation the buyer asked for ends it.
  const releaseSlot=()=>admin.query(`UPDATE payment_orders SET qualification_state='released' WHERE id=(SELECT id FROM payment_orders
    WHERE offer_kind='founder' AND qualification_state='reserved' AND payment_mode='test' ORDER BY created_at LIMIT 1)`);
  const deadline=async f=>(await admin.query('SELECT pay_waffo_founder_deadline($1) v',[f.o.id])).rows[0].v;
  await releaseSlot(); const exhausted=await paidFirst('card_cn','founder','yearly','a4'.repeat(32));
  await fail(exhausted,new Date(exhausted.end.getTime()+3600000),'in_exhausted');
  await sync(exhausted,false,true,false);
  assert.ok(await deadline(exhausted),'retry exhaustion keeps the 7-day founder window');
  await releaseSlot(); const optedOut=await paidFirst('card_cn','founder','yearly','a5'.repeat(32));
  await fail(optedOut,new Date(optedOut.end.getTime()+3600000),'in_opted_out');
  await sync(optedOut,false,true,true);
  assert.equal(await deadline(optedOut),null,'a cancellation the buyer asked for ends the founder window');
  await assert.rejects(()=>sync(card,false,false,true),/RENEW_SCOPE/,'a user cancellation is always a final cancellation');

  // One function by this name (no leftover 4-parameter overload).
  assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='pay_stripe_mp_sync_subscription'`)).rows[0].n,1);

  // Scope: only Stripe card subscriptions, never Waffo or wallet ones.
  const waffoSub=(await admin.query("SELECT id FROM user_subscriptions WHERE payment_channel='waffo' LIMIT 1")).rows[0]?.id;
  if(waffoSub) await assert.rejects(()=>service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',true,false,false)`,[waffoSub]),/RENEW_SCOPE/);
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>sync(card,true,false),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-grace-card-and-card-cn','stripe-mp-failure-recorded-once','stripe-mp-failure-earliest-out-of-order','stripe-mp-past-due-keeps-grace',
    'stripe-mp-renewal-list-price-not-first-month','stripe-mp-renewal-pre-tax-only','stripe-mp-renewal-tax-recorded','stripe-mp-renewal-once-concurrently',
    'stripe-mp-renewal-clears-failure','stripe-mp-next-charge-date','stripe-mp-one-order-per-period','stripe-mp-stop-ends-grace',
    'stripe-mp-cancel-permanent','stripe-mp-cancel-resets-cached-level','stripe-mp-cancel-keeps-remaining-level','stripe-mp-erasure-renewing-follows-stop','stripe-mp-charge-after-cancel-review','stripe-mp-founder-card-cn-deadline','stripe-mp-founder-renewal','stripe-mp-founder-window-retry-exhausted','stripe-mp-founder-window-user-cancel','stripe-mp-sync-single-signature','stripe-mp-renewal-scope'];
}
