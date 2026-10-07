/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {transport} from './adapter.mjs';
import {provider} from './provider.mjs';
export async function runService({db,service,webhook,report}) {
 const client=transport(db);
 const fixture=async()=> (await db.query('select monthly_test.fixture() f')).rows[0].f;
 for(const failure of [null,'stop','refund','cancel','failed','closed','db_result','conflict']) {
  const f=await fixture(),remote=provider(f);
  const input={orderId:f.order,ticketId:f.ticket,feePermitted:'confirmed',feeEvidence:'fixture:law'};
  const quote=await service.quoteMonthlyRefund(client,remote.stripe,f.actor,input);
  const i=await service.approveMonthlyRefund(client,remote.stripe,f.actor,{...input,...quote});
  assert.equal(i.status,'approved');
  const executingAdmin=(await db.query("insert into profiles(id,role) values(gen_random_uuid(),'admin') returning id")).rows[0].id;remote.setFailure(failure==='closed'?'refund':failure==='conflict'?'cancel':failure);
  let failResult=failure==='db_result';
  const faultClient={...client,rpc:async(name,args)=>{
   if(name==='pay_common_monthly_refund_result'&&failResult){failResult=false;return {data:null,error:new Error('Synthetic result-write interruption')};}
   return client.rpc(name,args);
  }};
  const first=await service.executeMonthlyRefund(faultClient,remote.stripe,executingAdmin,f.order,i.id);
  if(failure==='conflict') {
   await service.recordMonthlyRefund(client,remote.stripe,f.order,{...remote.refunds[0],status:'failed'});
   const count=remote.writes.length;remote.setFailure(null);
   assert.equal((await service.executeMonthlyRefund(client,remote.stripe,executingAdmin,f.order,i.id)).reason,'recorded_cash_conflict');
   assert.equal(remote.writes.length,count,'persisted conflict forbids another cancellation despite fresh succeeded cash');
   continue;
  }
  if(failure==='db_result') {
   assert.equal((await service.readMonthlyRefundStatus(client,f.order)).recordedRefund,null);
   const count=remote.writes.length;
   assert.equal(await webhook.syncMonthlyRefundSubscription(client,remote.stripe,remote.sub.id),true);
   assert.equal((await service.readMonthlyRefundStatus(client,f.order)).recordedRefund.status,'succeeded');
   assert.equal(remote.writes.length,count,'late lifecycle webhook only records; no dispatch');
  }
  if(failure==='closed') {
   const original=(await db.query('select refund_approval from payment_orders where id=$1',[f.order])).rows[0].refund_approval;
   await db.query('select account_erasure_confirm($1,gen_random_uuid())',[f.user]);
   for(const table of ['payment_orders','user_subscriptions','subscription_credit_grants']){
    await db.query('select account_erasure_scrub_payment($1,$2)',[f.user,table]);
   }
   await db.query("select account_erasure_scrub_ledger($1,'credit_transactions')",[f.user]);
   const kept=(await db.query('select refund_approval from payment_orders where id=$1',[f.order])).rows[0].refund_approval;
   assert.deepEqual(kept,original,'closure/projection preserve original approval and request identity');
   const pending=(await db.query('select account_erasure_financial_proof($1) p',[f.user])).rows[0].p;
   assert.ok(pending.financialPending>0);
  }
  if(failure && failure!=='failed') {
   assert.equal(first.status,'review_required');remote.setFailure(null);
  }
  const final=await service.executeMonthlyRefund(client,remote.stripe,executingAdmin,f.order,i.id);
  assert.equal(final.status,failure==='failed'?'failed':'succeeded',JSON.stringify({failure,first,final}));
  assert.equal(final.id,i.id);assert.equal(final.versionHash,i.versionHash);
  assert.equal(remote.writes.filter(r=>r.stage==='refund').length,1,'query-before-retry must not refund twice');
  assert.ok(remote.writes.every(r=>r.stage==='cancel'||r.key.startsWith(`pay-common:monthly-refund:${i.id}:`)));
  const balance=(await db.query('select credits,membership_level,status,is_deleted from profiles where id=$1',[f.user])).rows[0];
  assert.equal(balance.credits,failure==='failed'?1500:400);
  assert.equal(balance.membership_level,failure==='failed'?'pro':'free');
  assert.equal(balance.status,failure==='closed'?'deleted':'active');
  assert.equal(balance.is_deleted,failure==='closed'?'true':'false');
  if(failure===null) {
   remote.refunds[0].metadata={};
   const before=remote.writes.length;
   const unmatched=await webhook.reconcileMonthlyRefundForOrder(client,f.order,remote.refunds[0].id,remote.stripe);
   assert.equal(unmatched.handled,true);assert.equal(unmatched.result.terminalConflict,true);
   assert.equal(remote.writes.length,before);
   assert.equal(unmatched.result.recordedRefund.status,'succeeded');
   assert.equal((await db.query('select credits from profiles where id=$1',[f.user])).rows[0].credits,400);
  }
  if(failure==='closed') {
   const settled=(await db.query('select account_erasure_financial_proof($1) p',[f.user])).rows[0].p;
   assert.deepEqual(settled,{financialPending:0,manualReview:0});
   assert.equal(final.versionHash,i.versionHash);assert.deepEqual(final.terms,i.terms);
  }
 }
 report.checks.push('persisted conflict blocks adapter; late lifecycle result after failed DB write; unmarked refund dispatches to monthly review without second clawback');
 report.checks.push('real TS reader/quote/approve/claim/adapter + PG: stop/refund/cancel timeout recovery, success/failure, fixed original keys');
}
