/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function stripeTestClockCases({admin,service,connect}) {
  const binding={projectId:'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',domain:'auth-staging.graylum.com',
    databaseHost:'gvcpmcunmfrbxuwimxfa.supabase.co',branch:'staging',repo:'Crnobog9527/GraylumAI_vercel'};
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...current,version,card:{enabled:true}}]);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
    VALUES('stripe','fixture','test','price','price_clock_pro',$1,'monthly',true,'standard','subscription')
    ON CONFLICT DO NOTHING`,[plan]);
  const start=new Date(Math.floor(Date.now()/1000)*1000),month=(date,n=1)=>{
    const d=new Date(date);d.setUTCMonth(d.getUTCMonth()+n);return d;};
  const fixture=async()=>{
    const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const digest=JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}]);
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','standard',
      'fixture','test',$3,'terms-v1',$4) o`,[user,plan,version,digest])).rows[0];
    const customer='cus_'+o.id.replaceAll('-',''),clock='clock_'+o.id.replaceAll('-',''),checkout='cs_'+o.id;
    const expiry=new Date(Date.now()+1800000);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method:'card',merchant:'fixture',mode:'test',providerRequest:{customer}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
    return {o,user,customer,clock,checkout,digest};
  };
  const observe=(f,at,b=binding)=>service.query('SELECT pay_stripe_test_clock_observe($1,$2,$3,$4,$5)',[f.o.id,f.customer,f.clock,at,b]);
  const first=f=>service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,2900,'usd',$4,$5,$4,$6) v`,
    [f.o.id,f.checkout,'in_first_'+f.o.id,start,'sub_'+f.o.id,month(start)]);
  const renew=(db,f,opts={})=>db.query(`SELECT pay_stripe_mp_renew_subscription($1,'fixture',$2,$3,$4,$5,$6,$7) v`,
    [f.sub,opts.invoice??'in_renew_'+f.o.id.replaceAll('-',''),opts.amount??2900,opts.currency??'usd',opts.paid??month(start),month(start),month(start,2)]);
  const facts=async f=>(await service.query('SELECT pay_common_membership_facts($1) v',[f.user])).rows[0].v.internal_membership;
  const balance=async f=>(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[f.user])).rows[0];
  const f=await fixture();f.sub=(await first(f)).rows[0].v.subscriptionId;
  const future=new Date(month(start).getTime()+3600000);
  await assert.rejects(()=>renew(service,f),/RENEW_CONFLICT/,'ordinary future payment still refused');
  for(const key of Object.keys(binding)) await assert.rejects(()=>observe(f,future,{...binding,[key]:'wrong'}),/TEST_CLOCK_SCOPE/);
  await assert.rejects(()=>service.query('SELECT pay_stripe_test_clock_observe($1,$2,$3,$4,$5)',
    [f.o.id,'cus_wrongowner',f.clock,future,binding]),/TEST_CLOCK_SCOPE/);
  await observe(f,future);await observe(f,start);
  await assert.rejects(()=>service.query("SELECT pay_stripe_mp_record_renewal_failure($1,'fixture','in_clock_failed',$2)",
    [f.sub,future]),/RENEW_SCOPE/,'failure event.created upper bound stays wall time');
  assert.equal((await service.query('SELECT pay_stripe_test_clock_time($1) v',[f.o.id])).rows[0].v.toISOString(),future.toISOString(),'no clock rewind');
  await assert.rejects(()=>service.query('SELECT pay_stripe_test_clock_observe($1,$2,$3,$4,$5)',
    [f.o.id,f.customer,'clock_rebinding',future,binding]),/TEST_CLOCK_REBIND/);
  await assert.rejects(()=>renew(service,f,{paid:new Date(future.getTime()+301000)}),/RENEW_CONFLICT/);
  await assert.rejects(()=>renew(service,f,{amount:3480}),/RENEW_CONFLICT/);
  await assert.rejects(()=>renew(service,f,{currency:'eur'}),/RENEW_CONFLICT/);
  const one=await connect(),two=await connect();await one.query('SET ROLE service_role');await two.query('SET ROLE service_role');
  const results=await Promise.all([renew(one,f),renew(two,f)]);
  assert.equal(results.filter(r=>r.rows[0].v.duplicate===false).length,1);
  const renewed=results.find(r=>!r.rows[0].v.duplicate).rows[0].v;
  assert.equal(renewed.state,'fulfilled');assert.equal(renewed.credits,3480);
  assert.deepEqual(await balance(f),{credits:6960,membership_level:'pro'});
  assert.equal((await renew(service,f)).rows[0].v.duplicate,true);
  assert.equal((await facts(f)).mapping_state,'internal_paid');
  const times=(await service.query('SELECT pay_stripe_test_clock_times($1) v',[f.user])).rows[0].v;
  assert.deepEqual(new Set(times.map(x=>x.orderId)),new Set([f.o.id,renewed.orderId]));
  await observe(f,new Date(month(start,2).getTime()+3600000));
  assert.ok((await facts(f)).renewal_grace_until,'one-hour failure grace');
  assert.equal((await balance(f)).credits,6960,'grace grants no credits');
  await observe(f,new Date(month(start,2).getTime()+25*3600000));
  assert.notEqual((await facts(f)).mapping_state,'internal_paid','grace ended at source+24h');
  await service.query("SELECT pay_stripe_mp_sync_subscription($1,'fixture',false,true,false)",[f.sub]);
  assert.equal((await balance(f)).membership_level,'free','cancel settles from source time');
  const again=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','standard',
    'fixture','test',$3,'terms-v1',$4) o`,[f.user,plan,version,f.digest])).rows[0];
  assert.equal(again.payment_status,'unpaid','ended clock subscription can buy again');
  const renewalInvoice='in_renew_'+f.o.id.replaceAll('-','');
  await service.query("SELECT pay_stripe_mp_record_tax($1,'fixture',$2,0)",[renewed.orderId,renewalInvoice]);
  await assert.rejects(()=>service.query("SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,'re_clock_future',2900,'usd',$3)",
    [renewed.orderId,renewalInvoice,future]),/REFUND_SCOPE/,'refund.created upper bound stays wall time');
  const refundRenewal=()=>service.query("SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,'re_clock_renewal',2900,'usd',$3) v",
    [renewed.orderId,renewalInvoice,start]);
  assert.equal((await refundRenewal()).rows[0].v.creditsTakenBack,3480);
  assert.equal((await refundRenewal()).rows[0].v.duplicate,true);
  assert.equal((await balance(f)).credits,3480,'only the refunded renewal source is taken back');

  // Each independent missing DB gate, including live mode, falls back to the existing real clock.
  for(const [key,value] of [['payment_mode','live'],['purchase_membership_level','gold']]) {
    // Invalid historical fixtures in this isolated DB only; production frozen-field guard remains installed.
    await assert.rejects(()=>admin.query(`UPDATE payment_orders SET ${key}=$2 WHERE id=$1`,[f.o.id,value]),/FROZEN_FIELD/);
    await admin.query('BEGIN');await admin.query("SET LOCAL session_replication_role='replica'");
    await admin.query(`UPDATE payment_orders SET ${key}=$2 WHERE id=$1`,[f.o.id,value]);
    assert.equal((await admin.query('SELECT pay_stripe_test_clock_time($1) v',[f.o.id])).rows[0].v,null,key);
    await assert.rejects(()=>admin.query('SELECT pay_stripe_test_clock_observe($1,$2,$3,$4,$5)',
      [f.o.id,f.customer,f.clock,future,binding]),/TEST_CLOCK_SCOPE/);
    await admin.query('ROLLBACK');
  }
  const early=await fixture();await observe(early,start);
  await assert.rejects(()=>service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,2900,'usd',$4,$5,$4,$6)`,
    [early.o.id,early.checkout,'in_early_'+early.o.id,new Date(start.getTime()-360000),'sub_'+early.o.id,month(new Date(start.getTime()-360000))]),
    /PAID_AT|PAYMENT|QUALIFICATION/,'first early-paid >5min still refused');

  const close=await fixture();await observe(close,start);
  const closeFacts={order:close.o.id,checkout:close.checkout,customer:close.customer,clock:close.clock,merchant:'fixture',
    invoice:'in_close_'+close.o.id.replaceAll('-',''),paymentIntent:'pi_close_'+close.o.id.replaceAll('-',''),
    charge:'ch_close_'+close.o.id.replaceAll('-',''),subscription:'sub_close_'+close.o.id.replaceAll('-',''),
    paidMinor:3190,taxMinor:290,currency:'usd',paidAt:new Date(start.getTime()-3600000).toISOString(),canceledAt:start.toISOString(),
    refunds:[{id:'re_close_'+close.o.id.replaceAll('-',''),amount:3190,createdAt:start.toISOString()}]};
  const finish=(db=service,p=closeFacts)=>db.query('SELECT pay_stripe_test_clock_close_refunded($1) v',[p]);
  for(const patch of [{paidMinor:2900},{currency:'eur'},{taxMinor:-1},{refunds:[{...closeFacts.refunds[0],amount:2900}]},
    {customer:'cus_wrongcustomer'},{clock:'clock_wrongclock'},{refunds:[closeFacts.refunds[0],closeFacts.refunds[0]]}]) {
    await assert.rejects(()=>finish(service,{...closeFacts,...patch}),/TEST_CLOCK_CLOSE/);
  }
  // Existing erasure, dispute and approved-refund protections are not relaxed by cash close.
  await admin.query("UPDATE profiles SET status='suspended' WHERE id=$1",[close.user]);
  await assert.rejects(()=>finish(),/CLOSE_PROTECTED/);
  await admin.query("UPDATE profiles SET status='active' WHERE id=$1",[close.user]);
  await admin.query(`UPDATE payment_orders SET refund_approval='{"hold":"held"}' WHERE id=$1`,[close.o.id]);
  await assert.rejects(()=>finish(),/CLOSE_PROTECTED/);
  await admin.query('UPDATE payment_orders SET refund_approval=NULL WHERE id=$1',[close.o.id]);
  await admin.query('BEGIN');
  await admin.query('INSERT INTO account_erasure_requests(profile_id,request_id) VALUES($1,$2)',[close.user,randomUUID()]);
  await assert.rejects(()=>finish(admin),/CLOSE_PROTECTED/);
  await admin.query('ROLLBACK');
  // A disputed payment wins the same canonical subscription/payment locks before any account/order lock.
  const protectedSource=await fixture();await observe(protectedSource,start);
  const protectedFacts={...closeFacts,order:protectedSource.o.id,checkout:protectedSource.checkout,
    customer:protectedSource.customer,clock:protectedSource.clock,
    paymentIntent:'pi_protected_'+protectedSource.o.id.replaceAll('-',''),
    charge:'ch_protected_'+protectedSource.o.id.replaceAll('-',''),subscription:'sub_protected_'+protectedSource.o.id.replaceAll('-','')};
  const paymentKey='fixture:test:'+protectedFacts.paymentIntent,subKey='fixture:test:'+protectedFacts.subscription;
  await one.query('RESET ROLE');await one.query('BEGIN');
  await one.query('SELECT pay_dispute_lock($1,$2)',[paymentKey,subKey]);
  await one.query(`INSERT INTO payment_disputes(merchant_namespace,mode,provider_dispute_id,payment_key,provider_charge_id,
    provider_payment_intent_id,provider_subscription_id,original_payment_at,last_event_at,order_id,amount,currency,
    reason,status,opened_at) VALUES('fixture','test',$1,$2,$3,$4,$5,$6,$6,$7,3190,'usd','fraudulent','needs_response',$6)`,
    ['du_clock_'+protectedSource.o.id.replaceAll('-',''),paymentKey,protectedFacts.charge,protectedFacts.paymentIntent,
      protectedFacts.subscription,start,protectedSource.o.id]);
  const rejected=assert.rejects(()=>finish(two,protectedFacts),/CLOSE_PROTECTED/);
  let blocked=false;
  for(let i=0;i<100&&!blocked;i++) {
    blocked=(await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 v',[two.processID])).rows[0].v;
    if(!blocked)await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(blocked,true,'close waits for existing dispute transaction');
  await one.query('COMMIT');await one.query('SET ROLE service_role');await rejected;
  const settled=await Promise.all([finish(one),finish(two)]);
  assert.equal(settled.filter(r=>r.rows[0].v.duplicate===false).length,1);
  assert.equal((await finish()).rows[0].v.duplicate,true);
  assert.deepEqual(await balance(close),{credits:0,membership_level:'free'});
  const closed=(await admin.query('SELECT status,payment_status,qualification_state,fulfilled_at,subscription_id,payment_amount_facts FROM payment_orders WHERE id=$1',[close.o.id])).rows[0];
  assert.deepEqual([closed.status,closed.payment_status,closed.qualification_state,closed.fulfilled_at,closed.subscription_id],
    ['refunded','refunded','released',null,null]);
  assert.equal(closed.payment_amount_facts.length,3);
  assert.equal((await first(close)).rows[0].v.reason,'refund_observed','late paid event grants nothing');
  await observe(close,future);
  const repurchase=(db)=>db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','standard',
    'fixture','test',$3,'terms-v1',$4) o`,[close.user,plan,version,close.digest]);
  const purchases=await Promise.all([repurchase(one),repurchase(two)]);
  assert.equal(purchases[0].rows[0].id,purchases[1].rows[0].id);
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>finish(),/permission denied/);
    await assert.rejects(()=>observe(close,future),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  return ['clock-renewal-concurrent-once','clock-real-upper-bound-unchanged','clock-binding-and-customer-scope',
    'clock-monotonic-no-rebind','clock-per-source-credits-and-entitlement','clock-grace-24h-cancel-repurchase',
    'clock-renewal-refund-source-only-once','clock-refund-real-time-guard-preserved',
    'clock-missing-gates-live-unchanged','clock-first-early-paid-guard','clock-full-refund-cash-no-delivery',
    'clock-close-amount-tax-currency-protected','clock-close-account-erasure-refund-hold-protected',
    'clock-close-dispute-concurrent-protected','clock-close-concurrent-once',
    'clock-close-late-paid-no-grant','clock-close-repurchase-concurrent-once','clock-rpc-service-only'];
}
