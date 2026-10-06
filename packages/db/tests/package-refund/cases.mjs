/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID as otherUuid} from 'node:crypto';
export async function runCases({db,Client,connectionString,report}) {
 const run=async(sql,args=[]) => (await db.query(sql,args)).rows;
 const fresh=async()=> (await run('select refund_test.fixture() f'))[0].f;
 const quote=async (f,fee='confirmed')=>(await run('select pay_common_package_refund_quote($1,$2,$3,$4,$5,$6) q',
  [f.actor,f.order,f.ticket,f.cash,fee,'legal-reference']))[0].q;
 const decide=async(f,q,decision='approve',client=db)=>(await client.query(
  'select pay_common_package_refund_decide($1,$2,$3,$4,$5,$6,$7,$8) q',
  [f.actor,f.order,f.ticket,f.cash,q.feePermitted,'legal-reference',q.versionHash,decision])).rows[0].q;
 const claim=async(f,i,client=db)=>(await client.query('select pay_common_package_refund_claim($1,$2,$3,$4) q',
  [f.actor,f.order,i.id,f.cash])).rows[0].q;
 const balance=async f=>(await run('select credits from profiles where id=$1',[f.user]))[0].credits;
 const result=async(f,i,status='succeeded')=>(await run('select pay_common_package_refund_result($1,$2,$3) q',
  [f.order,i.id,{id:'re_'+i.id,intentId:i.id,orderId:f.order,paymentIntentId:f.cash.paymentIntentId,
   chargeId:f.cash.chargeId,currency:'usd',amount:i.netMinor,mode:'test',merchant:'acct_fixture',status}]))[0].q;
 let f=await fresh(),q=await quote(f);
 assert.equal(q.feeMinor,600);assert.equal(q.netMinor,9400);assert.equal(q.credits,1100);
 let i=await decide(f,q);
 assert.equal((await decide(f,q)).id,i.id);
 await claim(f,i);assert.equal(await balance(f),400);
 assert.equal((await run('select pay_common_package_refund_retry($1,$2,$3,$4) q',[f.actor,f.order,i.id,f.cash]))[0].q.id,i.id);
 await assert.rejects(()=>run('select pay_common_package_refund_retry($1,$2,$3,$4)',[f.user,f.order,i.id,f.cash]),/PAY_REFUND_ADMIN_REQUIRED/);
 await assert.rejects(()=>claim(f,i),/PAY_REFUND_NOT_APPROVED/);
 for(const delta of [{amount:1},{currency:'eur'},{chargeId:'ch_other'},{paymentIntentId:'pi_other'},
   {intentId:otherUuid()},{mode:'live'},{merchant:'acct_other'}]) {
  await assert.rejects(()=>run('select pay_common_package_refund_result($1,$2,$3)',[f.order,i.id,
   {id:'re_'+i.id,intentId:i.id,orderId:f.order,paymentIntentId:f.cash.paymentIntentId,
    chargeId:f.cash.chargeId,currency:'usd',amount:i.netMinor,mode:'test',merchant:'acct_fixture',status:'succeeded',...delta}]),
   /PAY_REFUND_RESULT_MISMATCH/);
 }
 await run("update payment_orders set metadata=metadata||jsonb_build_object('providerSync',true) where id=$1",[f.order]);
 await result(f,i);await result(f,i);await result(f,i,'pending');
 assert.equal(await balance(f),400);
 let o=(await run('select status,refund_approval from payment_orders where id=$1',[f.order]))[0];
 assert.equal((await run("select count(*)::int n from payment_provider_refs where order_id=$1 and object_type='refund'",[f.order]))[0].n,1);
 assert.equal(o.status,'partially_refunded');assert.equal(o.refund_approval.status,'succeeded');
 assert.equal((await run("select count(*)::int n from credit_transactions where source_order_id=$1 and ledger_type='refund_clawback'",[f.order]))[0].n,1);
 report.checks.push('allowed approve/claim, 6% cash, full package+bonus clawback, other 400 unchanged, duplicate/late pending idempotent');
 f=await fresh();q=await quote(f);i=await decide(f,q);await claim(f,i);
 await result(f,i,'failed');await result(f,i,'failed');assert.equal(await balance(f),1500);
 await assert.rejects(()=>result(f,i),/PAY_REFUND_TERMINAL_CONFLICT/);
 f=await fresh();q=await quote(f,'not_permitted');assert.equal(q.feeMinor,0);
 i=await decide(f,q);await claim(f,i);await result(f,i);
 assert.equal((await run('select payment_status from payment_orders where id=$1',[f.order]))[0].payment_status,'refunded');
 assert.equal(await balance(f),400);
 report.checks.push('fee prohibited: full cash refund still one full package clawback');
 report.checks.push('confirmed failure restores exactly once; contradictory success fails closed');
 f=await fresh();q=await quote(f);i=await decide(f,q,'reject');
 await assert.rejects(()=>claim(f,i),/PAY_REFUND_NOT_APPROVED/);
 i=await decide(f,q);
 await run("insert into credit_transactions(user_id,amount,type,ledger_type) values($1,-1,'consumption','spend')",[f.user]);
 await assert.rejects(()=>claim(f,i),/PAY_REFUND_CONSUMPTION_OR_UNKNOWN/);
 report.checks.push('rejected approval and new consumption stop dispatch');
 f=await fresh();
 await assert.rejects(()=>quote({...f,actor:f.user}),/PAY_REFUND_ADMIN_REQUIRED/);
 const other=await fresh();
 await assert.rejects(()=>quote({...f,ticket:other.ticket}),/PAY_REFUND_TICKET_MISMATCH/);
 await assert.rejects(()=>quote({...f,cash:{...f.cash,disputed:true}}),/PAY_REFUND_CASH_EVIDENCE_INVALID/);
 await assert.rejects(()=>quote({...f,cash:{...f.cash,refundedMinor:1}}),/PAY_REFUND_CASH_EVIDENCE_INVALID/);
 await assert.rejects(()=>quote({...f,cash:{...f.cash,paidAt:new Date(Date.now()-9*86400000).toISOString()}}),/PAY_REFUND_WINDOW/);
 q=await quote(f);
 await assert.rejects(()=>decide(f,{...q,versionHash:'stale'}),/PAY_REFUND_STALE_PREVIEW/);
 await run("insert into billing_history(user_id,operation_type,amount,created_at) values($1,'pre_deduct',10,now()-interval '2 days')",[f.user]);
 await assert.rejects(()=>quote(f),/PAY_REFUND_SETTLEMENT_UNRESOLVED/);
 const rejected=(await run('select pay_common_package_refund_reject($1,$2,$3,$4) q',
  [f.actor,f.order,f.ticket,'ineligible']))[0].q;
 assert.equal(rejected.status,'rejected');
 report.checks.push('ineligible/pending-settlement request can be rejected without cash evidence');
 report.checks.push('denied non-admin/cross-subject/stale/disputed/partial/late and pre-payment pending reservation');
 f=await fresh();
 for(const role of ['anon','authenticated']) {
  await run('set role '+role);
  await assert.rejects(()=>quote(f),/permission denied/);
  await assert.rejects(()=>run('update payment_orders set refund_approval=$1 where id=$2',['{}',f.order]),/permission denied/);
  await run('reset role');
 }
 await run('set role service_role');q=await quote(f);i=await decide(f,q);await claim(f,i);await result(f,i);
 await run('reset role');
 report.checks.push('client roles cannot approve/write; service-role path validates admin');
 const second=new Client({connectionString});await second.connect();
 try {
  f=await fresh();q=await quote(f);
  const both=await Promise.all([decide(f,q),decide(f,q,'approve',second)]);
  assert.equal(both[0].id,both[1].id);i=both[0];
  const claims=await Promise.allSettled([claim(f,i),claim(f,i,second)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await balance(f),400);
  // A spending transaction holding the same profile lock wins before the claim.
  f=await fresh();q=await quote(f);i=await decide(f,q);
  await second.query('begin');
  await second.query('select id from profiles where id=$1 for update',[f.user]);
  const pending=claim(f,i).then(()=>{throw Error('claim should reject')},e=>assert.match(e.message,/PAY_REFUND_CONSUMPTION_OR_UNKNOWN/));
  await second.query("insert into credit_transactions(user_id,amount,type,ledger_type) values($1,-1,'consumption','spend')",[f.user]);
  await second.query('commit');await pending;
  report.checks.push('two connections: one approval identity/one claim; concurrent consumption before claim rejects');
 } finally {await second.end();}
 // Legacy webhook while a dispatch is unknown cannot claw back the same purchase again.
 f=await fresh();q=await quote(f);i=await decide(f,q);await claim(f,i);
 await run("select * from atomic_reconcile_stripe_refund($1,'external-event','refund.updated','re_unmatched','succeeded',10000,'usd')",[f.order]);
 assert.equal(await balance(f),400);
 assert.equal((await run("select metadata->'refundExecutionUnmatchedEvent'->>'reviewRequired' v from payment_orders where id=$1",[f.order]))[0].v,'true');
 await result(f,i);assert.equal(await balance(f),400);
 report.checks.push('unmatched external refund evidence retained, no second clawback; local replay of known cash success once');
 f=await fresh();
 await run("select * from atomic_reconcile_stripe_refund($1,'legacy-refund:'||($1::uuid)::text,'refund.updated','re_legacy','succeeded',10000,'usd',null,null,null,null,null,now(),true,false)",[f.order]);
 assert.equal(await balance(f),400);
 report.checks.push('legacy unapproved full refund still uses existing reconciliation');

}
