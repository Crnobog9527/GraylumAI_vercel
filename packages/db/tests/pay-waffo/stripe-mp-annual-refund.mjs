/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {addUtcMonths} from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-REFUND: use real local checkout/fulfillment RPCs; no remote provider call or fabricated webhook. */
export async function stripeMpAnnualRefundCases({admin,service,connect}) {
 const plans={};
 for(const [level,monthly,yearly,credits] of [['pro',2900,27900,3480],['gold',6900,62100,8970]]) {
  plans[level]=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,
   yearly_credits,allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES($1,$1,$2,$3,$4,$4::integer*12,false,false,0)
   ON CONFLICT(level) DO UPDATE SET monthly_price=$2,yearly_price=$3,monthly_credits=$4,yearly_credits=$4::integer*12 RETURNING id`,
   [level,monthly,yearly,credits])).rows[0].id;
 }
 for(const [level,offer] of [['pro','standard'],['gold','standard'],['gold','founder']]) {
  if(!(await admin.query(`SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace='fixture'
   AND mode='test' AND object_type='price' AND membership_plan_id=$1 AND billing_cycle='yearly' AND offer_kind=$2
   AND price_usage='subscription' AND is_current`,[plans[level],offer])).rowCount)
   await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',$1,
    $2,'yearly',true,$3,'subscription')`,[`price_refund_annual_${level}_${offer}`,plans[level],offer]);
 }
 for(const cycle of ['monthly','yearly']) if(!(await admin.query(`SELECT 1 FROM payment_provider_refs WHERE channel='stripe'
  AND merchant_namespace='fixture' AND mode='test' AND object_type='price' AND membership_plan_id=$1 AND billing_cycle=$2
  AND offer_kind='standard' AND price_usage='one_time' AND is_current`,[plans.pro,cycle])).rowCount)
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
   membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',$1,$2,$3,
   true,'standard','one_time')`,[`price_refund_wallet_pro_${cycle}`,plans.pro,cycle]);
 const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
 const version=current.version+1;
 await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
  [{...current,version,card:{enabled:true},card_cn:{enabled:true},
   wechat_pay:{enabled:true,annualVerified:true},alipay:{enabled:true,annualVerified:true}}]);
 const actor=randomUUID();await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[actor]);
 const one=async(sql,args,db=service)=>(await db.query(sql,args)).rows[0];
 const identity=()=>JSON.stringify([{kind:'email',key_version:'test-v1',digest:randomUUID().replaceAll('-','').repeat(2)}]);
 const termsFor=async(user,id,paidAt,priorPro)=>{
  const o=await one('SELECT * FROM payment_orders WHERE id=$1',[id],admin);
  const s=await one('SELECT * FROM user_subscriptions WHERE id=$1',[o.subscription_id],admin);
  const ticket=await one("INSERT INTO tickets(user_id,title,category) VALUES($1,'annual refund','billing') RETURNING id,created_at::text",
   [user],admin);
  const credits=Number((await one('SELECT sum(credits_granted) n FROM subscription_credit_grants WHERE source_order_id=$1',[id],admin)).n);
  return {user,order:id,sub:s.id,end:s.current_period_end,credits,terms:{kind:'monthly_first_purchase',orderId:id,userId:user,
   ticketId:ticket.id,subscriptionId:s.id,providerSubscriptionId:o.auto_renew?`sub_${id}`:null,paymentIntentId:`pi_${id}`,chargeId:`ch_${id}`,
   invoiceId:o.auto_renew?`in_${id}`:`pi_${id}`,merchant:'fixture',mode:'test',currency:'usd',plan:o.purchase_membership_level,
   paidAt:paidAt.toISOString(),submittedAt:ticket.created_at,periodEnd:s.current_period_end.toISOString(),
   originalCancelAtPeriodEnd:false,paidMinor:o.amount_total,basisMinor:o.amount_total,feeMinor:0,
   taxMinor:o.payment_method==='card'?100:0,netMinor:o.amount_total+(o.payment_method==='card'?100:0),credits,
   feePermitted:'not_permitted',feeEvidence:'legal:location-unknown:2026-10',evidenceRefs:['a','b','c','d'],
   snapshot:o.purchase_snapshot,...(priorPro?{priorPro}:{})}};
 };
 const fulfill=async(user,o,method,start)=>{
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
  const expiry=new Date(Date.now()+1800000);
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
   {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
  await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',`cs_${o.id}`,expiry]);
  const end=new Date(start);
  if(o.billing_cycle==='yearly') end.setUTCFullYear(end.getUTCFullYear()+1);else end.setTime(addUtcMonths(end,1));
  const recurring=['card','card_cn'].includes(method),paidAt=new Date(start.getTime()+(recurring?1000:0));
  assert.equal((await one('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
   [o.id,'fixture',`cs_${o.id}`,recurring?`in_${o.id}`:`pi_${o.id}`,o.amount_total,'usd',paidAt,
    recurring?`sub_${o.id}`:null,start,end])).v.state,'fulfilled');
  if(method==='card') await service.query("SELECT pay_stripe_mp_record_tax($1,'fixture',$2,100)",[o.id,`in_${o.id}`]);
  return paidAt;
 };
 const buyer=async(level='pro',offer='standard',method='card_cn',days=1,cycle='yearly')=>{
  const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
  const o=await one(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$7,$3,$4,
   'fixture','test',$5,'terms-v1',$6) o`,[user,plans[level],method,offer,version,identity(),cycle]);
  const start=new Date(Math.floor(Date.now()/1000)*1000-days*86400000);
  return termsFor(user,o.id,await fulfill(user,o,method,start));
 };
 const approve=async(f,db=service)=>{
  const q=(await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4) q',[actor,f.order,f.terms,'a'.repeat(64)],db)).q;
  return (await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4,$5) i',
   [actor,f.order,f.terms,'a'.repeat(64),q.localVersion],db)).i;
 };
 const claim=async(f,i,db=service)=>(await one('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) i',
  [actor,f.order,i.id,f.terms],db)).i;
 const seen=(f,patch={},refunds=[])=>({checkedAt:new Date().toISOString(),merchant:'fixture',mode:'test',
  subscription:{id:f.terms.providerSubscriptionId,periodEnd:f.terms.periodEnd,status:'active',cancelAtPeriodEnd:true,
   renewalOwnership:'intent',preflight:'clear',...patch},refunds:{complete:true,rows:refunds}});
 const stage=async(f,i,name,e)=>(await one('SELECT pay_common_monthly_refund_start($1,$2,$3,$4,$5,$6) i',
  [actor,f.order,i.id,i.revision,name,e??seen(f)])).i;
 const fact=(f,i,status='succeeded')=>({id:`re_${f.order}`,intentId:i.id,orderId:f.order,chargeId:f.terms.chargeId,
  paymentIntentId:f.terms.paymentIntentId,currency:'usd',amount:f.terms.netMinor,merchant:'fixture',mode:'test',status});
 const done=async(f,i,closeAccount=false)=>{
  i=await stage(f,i,'stop_renewal',seen(f,{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
  await service.query('SELECT pay_common_monthly_refund_observe($1,$2,$3,$4)',[actor,f.order,i.id,seen(f)]);
  i=await stage(f,i,'refund');
  const r=fact(f,i);
  i=(await one('SELECT pay_common_monthly_refund_result($1,$2,$3) i',[f.order,i.id,r])).i;
  i=await stage(f,i,'cancel');
  // Stripe's final canceled subscription can report false. Persist the observation, do not invent true.
  const e=seen(f,{status:'canceled',cancelAtPeriodEnd:false},[r]);
  if(closeAccount) await admin.query('SELECT account_erasure_confirm($1,$2)',[f.user,randomUUID()]);
  const finish=()=>one('SELECT pay_common_monthly_refund_finish($1,$2,$3,$4) i',[actor,f.order,i.id,e]);
  i=(await finish()).i;assert.equal((await finish()).i.status,'succeeded');
  assert.deepEqual(i.renewalEvidence,{beforeCancelAtPeriodEnd:false,afterCancelAtPeriodEnd:false});
  assert.equal((await one('SELECT cancel_at_period_end FROM user_subscriptions WHERE id=$1',[f.sub],admin)).cancel_at_period_end,'false');
  assert.equal((await one('SELECT monthly_refund_erasure_safe($1) ok',[i],admin)).ok,true);
  assert.equal((await one('SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND ledger_type=$2',
   [f.order,'refund_clawback'],admin)).n,1,'duplicate completion cannot claw back again');
  return i;
 };
 const cn=await buyer();assert.equal(cn.credits,3480);assert.equal(cn.terms.snapshot.credits,41760);
 let i=await claim(cn,await approve(cn));
 assert.equal((await one('SELECT pay_waffo_grant_period($1,2) n',[cn.order])).n,0,'held annual source does not release');
 await done(cn,i);
 assert.equal((await one('SELECT credits FROM profiles WHERE id=$1',[cn.user],admin)).credits,0);
 const issued=await buyer('pro','standard','card_cn',40);
 await service.query('SELECT pay_waffo_grant_period($1,2)',[issued.order]);
 issued.terms.credits=issued.credits=Number((await one(
  'SELECT sum(credits_granted) n FROM subscription_credit_grants WHERE source_order_id=$1',[issued.order],admin)).n);
 assert.equal(issued.credits,6960,'two of twelve periods have actually been issued');
 issued.terms.submittedAt=new Date(Date.parse(issued.terms.paidAt)+86400000).toISOString();
 await admin.query('UPDATE tickets SET created_at=$2 WHERE id=$1',[issued.terms.ticketId,issued.terms.submittedAt]);
 await done(issued,await claim(issued,await approve(issued)));
 assert.equal((await one('SELECT credits FROM profiles WHERE id=$1',[issued.user],admin)).credits,0);
 const card=await buyer('gold','standard','card');await done(card,await claim(card,await approve(card)));
 const used=await buyer();
 await admin.query(`INSERT INTO credit_transactions(idempotency_key,user_id,amount,type,ledger_type,counts_as_spend,balance_before,balance_after)
  VALUES('fixture:'||gen_random_uuid(),$1,-1,'deduction','spend',true,3480,3479)`,[used.user]);
 await assert.rejects(()=>approve(used),/CONSUMPTION_OR_UNKNOWN/);
 const late=await buyer('pro','standard','card_cn',8);await assert.rejects(()=>approve(late),/PAY_REFUND_WINDOW/);
 const pending=await buyer();let pi=await claim(pending,await approve(pending));
 pi=await stage(pending,pi,'stop_renewal',seen(pending,{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
 pi=await stage(pending,pi,'refund');const pendingFact=fact(pending,pi,'pending');
 pi=(await one('SELECT pay_common_monthly_refund_result($1,$2,$3) i',[pending.order,pi.id,pendingFact])).i;
 await assert.rejects(()=>service.query('SELECT pay_common_monthly_refund_finish($1,$2,$3,$4)',
  [actor,pending.order,pi.id,seen(pending,{},[pendingFact])]),/PAY_MONTHLY_FINALIZE_CONFLICT/);
 assert.deepEqual([pi.status,pi.hold],['review_required','held'],'unknown cash never restores credits or ends the intent');
 const founder=await buyer('gold','founder');
 await service.query('SELECT founder_wall_submit($1,$2,$3)',[founder.user,{displayName:'Refund fixture',socialAccounts:[]},'fw-v1']);
 const wall=await one('SELECT updated_at::text FROM founder_wall_entries WHERE user_id=$1',[founder.user],admin);
 await service.query("SELECT founder_wall_review($1,$2,'approved',$3)",[actor,founder.user,wall.updated_at]);
 assert.equal((await one('SELECT founder_wall_listed($1) v',[founder.user],admin)).v,true);
 await done(founder,await claim(founder,await approve(founder)));
 assert.equal((await one('SELECT pay_founder_status($1) v',[founder.user])).v.state,'ended');
 assert.equal((await one('SELECT founder_wall_listed($1) v',[founder.user],admin)).v,false);
 assert.equal((await one('SELECT qualification_state FROM payment_orders WHERE id=$1',[founder.order],admin)).qualification_state,'sold');

 const upgradeBuyer=async(method='card_cn',cycle='yearly')=>{
  const prior=await buyer('pro','standard',method,1,cycle),autoRenew=['card','card_cn'].includes(method);
 if(autoRenew) await service.query("SELECT pay_stripe_mp_observe_subscription($1,'fixture')",[prior.sub]);
 const gold=await one(`SELECT o.* FROM pay_waffo_create_transition($1,$2,'yearly','card_cn','standard','fixture',$3,
  'terms-v1',$4,'upgrade',$5) o`,[prior.user,plans.gold,version,identity(),prior.sub]);
 const paid=await fulfill(prior.user,gold,'card_cn',new Date(Math.floor(Date.now()/1000)*1000-60000));
 if(autoRenew) await service.query("SELECT pay_stripe_mp_sync_subscription($1,'fixture',true,false,false)",[prior.sub]);
 const upgrade=await termsFor(prior.user,gold.id,paid,{orderId:prior.order,subscriptionId:prior.sub,
  providerSubscriptionId:prior.terms.providerSubscriptionId,invoiceId:prior.terms.invoiceId,periodEnd:prior.terms.periodEnd,autoRenew});
  return {prior,upgrade};
 };
 const {prior,upgrade}=await upgradeBuyer();
 const original=await one('SELECT current_period_end,cancel_at_period_end FROM user_subscriptions WHERE id=$1',[prior.sub],admin);
 const parallel=await connect();await parallel.query('SET ROLE service_role');
 const approved=await Promise.all([approve(upgrade),approve(upgrade,parallel)]);
 assert.equal(approved[0].id,approved[1].id,'concurrent approval shares one durable intent');
 const claims=await Promise.allSettled([claim(upgrade,approved[0]),claim(upgrade,approved[1],parallel)]);
 assert.equal(claims.filter(row=>row.status==='fulfilled').length,1,'concurrent execution claims hold once');
 const claimed=claims.find(row=>row.status==='fulfilled').value;
 await done(upgrade,claimed);
 assert.deepEqual(await one('SELECT current_period_end,cancel_at_period_end FROM user_subscriptions WHERE id=$1',[prior.sub],admin),original);
 assert.deepEqual(await one('SELECT credits,membership_level FROM profiles WHERE id=$1',[prior.user],admin),{credits:3480,membership_level:'pro'});
 assert.equal((await one('SELECT status FROM subscription_credit_grants WHERE source_order_id=$1',[prior.order],admin)).status,'granted');
 for(const [method,cycle] of [['wechat_pay','monthly'],['alipay','yearly']]) {
  const wallet=await upgradeBuyer(method,cycle);
  const originalWallet=await one('SELECT current_period_end,cancel_at_period_end FROM user_subscriptions WHERE id=$1',
   [wallet.prior.sub],admin);
  assert.equal(wallet.upgrade.terms.priorPro.autoRenew,false);
  assert.equal(wallet.upgrade.terms.priorPro.providerSubscriptionId,null);
  assert.equal((await one("SELECT count(*)::int n FROM payment_provider_refs WHERE subscription_id=$1 AND object_type='subscription'",
   [wallet.prior.sub],admin)).n,0,'one-time Pro has no provider subscription');
  for(const mismatch of [{autoRenew:true},{providerSubscriptionId:'sub_invented'}])
   await assert.rejects(()=>approve({...wallet.upgrade,terms:{...wallet.upgrade.terms,
    priorPro:{...wallet.upgrade.terms.priorPro,...mismatch}}}),/PAY_REFUND_PRIOR_PRO_UNRESOLVED/);
  const walletDone=await done(wallet.upgrade,await claim(wallet.upgrade,await approve(wallet.upgrade)));
  assert.equal((await one('SELECT monthly_refund_erasure_safe($1) ok',[{...walletDone,terms:{...walletDone.terms,
   priorPro:{...walletDone.terms.priorPro,providerSubscriptionId:'sub_invented'}}}],admin)).ok,false);
  assert.deepEqual(await one('SELECT current_period_end,cancel_at_period_end FROM user_subscriptions WHERE id=$1',
   [wallet.prior.sub],admin),originalWallet,'wallet paid end and no-renewal state are preserved');
  assert.deepEqual(await one('SELECT credits,membership_level FROM profiles WHERE id=$1',[wallet.prior.user],admin),
   {credits:3480,membership_level:'pro'});
  assert.equal((await one('SELECT status FROM subscription_credit_grants WHERE source_order_id=$1',[wallet.prior.order],admin)).status,'granted');
  if(cycle==='yearly') assert.equal((await one('SELECT credit_release_terminated_at FROM user_subscriptions WHERE id=$1',
   [wallet.prior.sub],admin)).credit_release_terminated_at,null,'remaining annual Pro releases retain the original schedule');
 }
 const closing=await upgradeBuyer();
 await done(closing.upgrade,await claim(closing.upgrade,await approve(closing.upgrade)),true);
 assert.deepEqual(await one('SELECT membership_level,is_deleted FROM profiles WHERE id=$1',[closing.prior.user],admin),
  {membership_level:'free',is_deleted:'true'},'settling accepted cash cannot restore a closed account tier');

 // A real renewed annual period is never a first purchase, even when requested within seven days of renewal.
 const old=await buyer('pro','standard','card_cn',370);
 const nextEnd=new Date(old.end);nextEnd.setUTCFullYear(nextEnd.getUTCFullYear()+1);
 const renewalPaid=new Date(old.end.getTime()+1000);
 const renewal=(await one("SELECT pay_stripe_mp_renew_subscription($1,'fixture',$2,27900,'usd',$3,$4,$5) v",
  [old.sub,`in_renew_${old.order.replaceAll('-','')}`,renewalPaid,old.end,nextEnd])).v;
 assert.equal(renewal.state,'fulfilled',JSON.stringify(renewal));
 const renew=await termsFor(old.user,renewal.orderId,renewalPaid);
 await assert.rejects(()=>approve(renew),/PAY_MONTHLY_SCOPE_OR_STATE/);
 await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...current,version:version+1}]);
 return ['annual-first-purchase-card-cn','annual-first-purchase-managed-tax','annual-only-issued-two-months-clawed-back','annual-used-rejected','annual-seven-days-rejected',
  'annual-founder-refund-unlisted-sold-retained','annual-upgrade-restores-paid-pro','annual-closed-upgrade-never-restores-tier','annual-concurrent-approval-one-intent',
  'annual-repeat-finish-one-clawback','annual-provider-cancel-evidence','annual-erasure-proof','annual-renewal-rejected',
  'annual-unknown-cash-keeps-manual-hold','annual-upgrade-from-monthly-wallet-pro','annual-upgrade-from-yearly-wallet-pro'];
}
