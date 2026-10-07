/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
export const CANARY='PAYMENT_PRIVATE_CANARY';
export const fresh=async db=>(await db.query('SELECT refund_test.fixture() f')).rows[0].f;
export const row=async(db,table,id)=>(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
export const scrub=(db,user,table,limit=100,after=null)=>rpc(db,'account_erasure_scrub_payment',user,table,limit,after);
export const close=(db,f)=>closeAccount(db,{actor:f.user});
const nonMetadata=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!['metadata','metadata_scrubbed_at'].includes(k)));
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const orderSafe={grantedCredits:1100,paymentIntentId:'pi_synthetic',requoteRequired:false,
 stripeRefund:{refundId:'re_synthetic',amount:10,refundAmount:'10.00',balanceBefore:null,reviewRequired:true,
 grantedCreditsMetadataGap:'missing_grantedCredits',
 termination:{written:true,terminatedAt:'2026-10-07T00:00:00Z',eventId:'evt_synthetic',reason:'stripe_refund'}},
 syncCheckoutSessionFulfillment:{status:'pending',reason:'paid_invoice_missing'},
 upgradeAttempt:{originalPrice:'price_original',itemId:'synthetic-item',createdAt:1791331200,
 quote:{amountDue:10,currency:'usd',quotedAt:1791331200,fingerprint:'synthetic-hash',freshnessProof:'synthetic-proof'},
 stripeMetadata:{orderId:'synthetic-order',userId:'synthetic-user',itemId:'synthetic-item',itemType:'membership_plan',
 billingCycle:'monthly',priceId:'price_synthetic',upgradeAttemptId:'synthetic-attempt'}}};
const dirtyOrder={...orderSafe,body:CANARY,
 syncCheckoutSessionFulfillment:{...orderSafe.syncCheckoutSessionFulfillment,body:CANARY},
 stripeRefund:{...orderSafe.stripeRefund,body:CANARY,
 termination:{...orderSafe.stripeRefund.termination,body:CANARY}},upgradeAttempt:{...orderSafe.upgradeAttempt,
 body:CANARY,quote:{...orderSafe.upgradeAttempt.quote,body:CANARY},stripeMetadata:{...orderSafe.upgradeAttempt.stripeMetadata,body:CANARY}}};
export async function subscription(db,f,metadata={},id=randomUUID()){
 const plan=(await db.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
 VALUES('Erasure synthetic',$1,false,false,0) RETURNING id`,['test_'+randomUUID()])).rows[0].id;
 await db.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,billing_cycle,status,
 cancel_at_period_end,current_period_start,current_period_end,metadata)
 VALUES($1,$2,$3,$4,'monthly','active','true',now(),now()+interval '1 month',$5)`,[id,f.user,plan,'sub_'+id,metadata]);
 return {id,plan};
}
export async function runCases(db,report){
 const f=await fresh(db),other=await fresh(db);
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  try{
   await assert.rejects(scrub(db,f.user,'payment_orders'),/permission denied/);
   await assert.rejects(rpc(db,'erasure_payment_metadata',{},'payment_orders'),/permission denied/);
  }finally{await db.query('RESET ROLE');}
 }
 await assert.rejects(scrub(db,f.user,'payment_orders'),/ACCOUNT_ERASURE_NOT_CLOSED/);
 for(const t of [null,'profiles','payment_orders; DROP TABLE profiles'])
  await assert.rejects(scrub(db,f.user,t),/ERASURE_PAYMENT_TABLE_DENIED/);
 for(const n of [null,0,101])await assert.rejects(scrub(db,f.user,'payment_orders',n),/ERASURE_BATCH_LIMIT_INVALID/);
 await db.query('SET ROLE service_role');
 try{assert.deepEqual(await rpc(db,'erasure_payment_metadata',dirtyOrder,'payment_orders'),{value:orderSafe,manualReview:0});}
 finally{await db.query('RESET ROLE');}
 const subSafe={lastInvoiceId:'in_synthetic',adminOverride:{adminId:'synthetic-admin',
 overriddenAt:'2026-10-07T00:00:00Z',previousLevel:'free',newLevel:'pro'}};
 const sub=await subscription(db,f,{...subSafe,body:CANARY,adminOverride:{...subSafe.adminOverride,reason:CANARY}});
 for(const legacy of [false,true])assert.deepEqual(await rpc(db,'erasure_payment_metadata',
  {adminOverride:legacy,body:CANARY},'user_subscriptions'),{value:{adminOverride:legacy},manualReview:0});
 assert.deepEqual(await rpc(db,'erasure_payment_metadata',
  {stripeRefund:{grantedCreditsMetadataGap:'invalid_grantedCredits'},body:CANARY},'payment_orders'),
 {value:{stripeRefund:{grantedCreditsMetadataGap:'invalid_grantedCredits'}},manualReview:0});
 const grantSafe={sourceType:'invoice',sourceId:'in_synthetic',reversal:{refundId:'re_synthetic',eventId:'evt_synthetic',
 subscriptionId:'sub_'+sub.id,periodKey:'synthetic-period',idempotencyKey:'synthetic-key',reversedAt:'2026-10-07T00:00:00Z',source:'stripe'}};
 const grant=(await db.query(`INSERT INTO subscription_credit_grants(user_id,membership_plan_id,stripe_subscription_id,
 billing_cycle,grant_type,grant_period_key,period_start,period_end,credits_granted,idempotency_key,metadata)
 VALUES($1,$2,$3,'monthly','monthly_invoice',$4,now(),now()+interval '1 month',100,$4,$5) RETURNING id`,
 [f.user,sub.plan,'sub_'+sub.id,randomUUID(),{...grantSafe,body:CANARY,reversal:{...grantSafe.reversal,body:CANARY}}])).rows[0].id;
 await db.query('UPDATE payment_orders SET metadata=$2 WHERE id=$1',[f.order,dirtyOrder]);
 const untouched=await row(db,'payment_orders',other.order);
 const specs=[['payment_orders',f.order,orderSafe],['user_subscriptions',sub.id,subSafe],['subscription_credit_grants',grant,grantSafe]];
 const before=await Promise.all(specs.map(([t,id])=>row(db,t,id)));await close(db,f);
 for(let n=0;n<specs.length;n++){
  const [t,id,expected]=specs[n];const result=await scrub(db,f.user,t);
  assert.equal(result.manualReview,0);assert.equal(result.remaining,0);
  const after=await row(db,t,id);assert.deepEqual(after.metadata,expected);assert.ok(after.metadata_scrubbed_at);
  assert.deepEqual(nonMetadata(after),nonMetadata(before[n]),'all amounts, snapshots, checkout/change requests and approval columns unchanged');
  assert.doesNotMatch(JSON.stringify(after.metadata),/PAYMENT_PRIVATE_CANARY/);
  assert.equal((await scrub(db,f.user,t)).processed,0);assert.deepEqual(await row(db,t,id),after);
  await assert.rejects(db.query(`UPDATE ${t} SET metadata_scrubbed_at=NULL WHERE id=$1`,[id]),/ERASURE_PAYMENT_IMMUTABLE/);
 }
 assert.deepEqual(await row(db,'payment_orders',other.order),untouched);
 report.checks.push('three payment tables: fixed recursive projection; full non-metadata row preserved; bounds/roles/injection/replay/actor isolation');
 await partial(db,report);await recovery(db,report);
}

async function partial(db,report){
 const f=await fresh(db);
 const unknown={refundAmount:{unknown:true,body:CANARY},reviewRequired:true};
 const conflict=[{code:'PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT',reason:'PAY_COMMON_RECEIPT_MISMATCH',
 evidence_ref:'synthetic-proof',extra:CANARY}];
 const freeReason={status:'pending',reason:CANARY,body:CANARY};
 await db.query('UPDATE payment_orders SET metadata=$2 WHERE id=$1',[f.order,
  {grantedCredits:1100,stripeRefund:unknown,paymentConflicts:conflict,syncCheckoutSessionFulfillment:freeReason,body:CANARY}]);
 const first='00000000-0000-4000-8000-000000000031',second='00000000-0000-4000-8000-000000000032';
 const adminOverride='unknown-legacy-financial-override';
 await subscription(db,f,{adminOverride,body:CANARY},first);await subscription(db,f,{lastInvoiceId:'in_second',body:CANARY},second);
 await close(db,f);
 const result=await scrub(db,f.user,'payment_orders');assert.equal(result.manualReview,1);assert.equal(result.remaining,1);
 const order=await row(db,'payment_orders',f.order);assert.ok(order.metadata_scrubbed_at,'partial projection records an irreversible scrub');
 await assert.rejects(db.query('UPDATE payment_orders SET metadata_scrubbed_at=NULL WHERE id=$1',[f.order]),/ERASURE_PAYMENT_IMMUTABLE/);
 const repeated=await scrub(db,f.user,'payment_orders');assert.equal(repeated.manualReview,1);assert.equal(repeated.remaining,1);
 assert.deepEqual(order.metadata,{grantedCredits:1100,stripeRefund:unknown,paymentConflicts:conflict,
 syncCheckoutSessionFulfillment:freeReason});
 assert.deepEqual((await row(db,'payment_orders',f.order)).metadata.syncCheckoutSessionFulfillment,freeReason,
  'repeated partial scrub preserves the unknown free-text financial subtree exactly');
 assert.deepEqual(await rpc(db,'erasure_payment_metadata',{body:CANARY,syncCheckoutSessionFulfillment:freeReason},'payment_orders'),
  {value:{syncCheckoutSessionFulfillment:freeReason},manualReview:1},'unknown reason alone cannot become clean');
 assert.equal(Object.hasOwn(order.metadata,'body'),false,'unrelated private body clears while uncertain financial subtree remains');
 const part=await scrub(db,f.user,'user_subscriptions',1);
 assert.deepEqual(part,{processed:1,remaining:2,manualReview:1,nextRowId:first});
 assert.deepEqual((await row(db,'user_subscriptions',first)).metadata,{adminOverride});
 const next=await scrub(db,f.user,'user_subscriptions',1,part.nextRowId);
 assert.equal(next.processed,1);assert.equal(next.remaining,1);assert.equal(next.manualReview,0);
 const grants=[];
 for(const [table,priv] of [['user_subscriptions','UPDATE'],['user_subscriptions','SELECT'],['profiles','SELECT'],['account_erasure_requests','SELECT']]){
  const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) ok',['service_role',table,priv])).rows[0].ok;
  if(!allowed){await db.query(`GRANT ${priv} ON ${table} TO service_role`);grants.push([table,priv]);}
 }
 // Only this disposable local fixture supplements missing platform ACLs; restore every added grant.
 try{
  await db.query('SET ROLE service_role');
  try{await db.query('UPDATE user_subscriptions SET metadata=$2 WHERE id=$1',[second,{lastInvoiceId:'in_late',body:CANARY}]);}
  finally{await db.query('RESET ROLE');}
 }finally{for(const [table,priv] of grants)await db.query(`REVOKE ${priv} ON ${table} FROM service_role`);}
 assert.deepEqual((await row(db,'user_subscriptions',second)).metadata,{lastInvoiceId:'in_late'});
 report.checks.push('unknown refund/admin override and append-only conflicts retain exact evidence and manual marker; separate body clears; cursor and late service update');
}

async function recovery(db,report){
 const f=await fresh(db);
 const q=await rpc(db,'pay_common_package_refund_quote',f.actor,f.order,f.ticket,f.cash,'confirmed','synthetic-legal-reference');
 const intent=await rpc(db,'pay_common_package_refund_decide',f.actor,f.order,f.ticket,f.cash,'confirmed',
  'synthetic-legal-reference',q.versionHash,'approve');
 await rpc(db,'pay_common_package_refund_claim',f.actor,f.order,intent.id,f.cash);
 await db.query("UPDATE payment_orders SET metadata=metadata||$2::jsonb WHERE id=$1",[f.order,{body:CANARY}]);
 const before=await row(db,'payment_orders',f.order),hash=digest(before.refund_approval);
 await close(db,f);await scrub(db,f.user,'payment_orders');
 const cleaned=await row(db,'payment_orders',f.order);
 assert.deepEqual(nonMetadata(cleaned),nonMetadata(before));assert.equal(digest(cleaned.refund_approval),hash);
 const evidence={id:'re_'+intent.id,intentId:intent.id,orderId:f.order,paymentIntentId:f.cash.paymentIntentId,
  chargeId:f.cash.chargeId,currency:'usd',amount:intent.netMinor,mode:'test',merchant:'acct_fixture',status:'succeeded'};
 await assert.rejects(rpc(db,'pay_common_package_refund_result',f.order,intent.id,{...evidence,amount:null}),/PAY_REFUND_RESULT_MISMATCH/);
 await rpc(db,'pay_common_package_refund_result',f.order,intent.id,evidence);
 await rpc(db,'pay_common_package_refund_result',f.order,intent.id,evidence);
 const done=await row(db,'payment_orders',f.order);assert.equal(done.refund_approval.status,'succeeded');
 assert.equal(done.refund_approval.id,intent.id);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.user])).rows[0].credits,400);
 assert.equal((await db.query("SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND ledger_type='refund_clawback'",[f.order])).rows[0].n,1);
 report.checks.push('real package refund approval hash/identity preserved; uncertain evidence denied; late synthetic result reconciles once without a new clawback');
}
