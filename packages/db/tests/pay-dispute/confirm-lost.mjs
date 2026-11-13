/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHARGEBACK G1: an admin confirms a lost dispute. Local PostgreSQL only; no Stripe, credentials or remote state.
import assert from 'node:assert/strict';
import pg from 'pg';

export async function confirmLostCases({c,v,profile,pack,receive,withdraw,ops,report,member,start,end}) {
 const asService=async(fn,client=c)=>{await client.query('SET ROLE service_role');try{return await fn();}finally{await client.query('RESET ROLE');}};
 const confirm=(actor,d,client=c)=>asService(()=>v('SELECT pay_dispute_confirm_lost($1,$2) v',[actor,d.id],client),client);
 const row=d=>c.query('SELECT * FROM payment_disputes WHERE id=$1',[d.id]).then(r=>r.rows[0]);
 const balance=user=>v('SELECT credits v FROM profiles WHERE id=$1',[user]);

 // Pack: open dispute holds the pack; confirmation is refused until Stripe closed it as lost; no new deduction.
 const user=await profile(0),p=await pack(user,100);
 const d=await receive(p);
 assert.equal(await balance(user),0);
 await assert.rejects(()=>confirm(ops,d),/PAY_DISPUTE_NOT_LOST/);
 await receive(p,{type:'charge.dispute.closed',status:'won'});
 await assert.rejects(()=>confirm(ops,d),/PAY_DISPUTE_NOT_LOST/);
 const lostUser=await profile(0),lp=await pack(lostUser,100);
 const ld=await receive(lp);
 await receive(lp,{type:'charge.dispute.closed',status:'lost'});
 const nonAdmin=await profile(0);
 await assert.rejects(()=>confirm(nonAdmin,ld),/PAY_DISPUTE_ADMIN_REQUIRED/);
 const first=await confirm(ops,ld);
 assert.equal(first.duplicate,false);assert.equal(first.heldCredits,100);
 assert.equal(await balance(lostUser),0);
 const ledger=await v('SELECT count(*)::int v FROM credit_transactions WHERE source_order_id=$1',[lp.order]);
 assert.equal((await confirm(ops,ld)).duplicate,true);
 assert.equal(await v('SELECT count(*)::int v FROM credit_transactions WHERE source_order_id=$1',[lp.order]),ledger);
 const after=await row(ld);
 assert.equal(after.freeze_state,'frozen');assert.equal(after.lost_confirmed_by,ops);assert.ok(after.lost_confirmed_at);
 assert.equal(await v('SELECT dispute_frozen_credits v FROM credit_package_sources WHERE order_id=$1',[lp.order]),100);
 await assert.rejects(()=>withdraw(ops,ld),/PAY_DISPUTE_LOST_CONFIRMED/);
 assert.equal(await balance(lostUser),0);
 // A late Stripe event after confirmation never reopens the dispute.
 await receive(lp,{type:'charge.dispute.updated',status:'under_review'});
 assert.equal((await row(ld)).status,'lost');
 report.checks.push('confirm lost: admin only, refused until closed lost, no new deduction, idempotent, blocks withdrawal');

 // Already withdrawn before the loss: never re-held automatically; confirmation is refused for a manual review.
 const wu=await profile(0),wp=await pack(wu,100),wd=await receive(wp);
 await withdraw(ops,wd);
 await receive(wp,{type:'charge.dispute.closed',status:'lost'});
 await assert.rejects(()=>confirm(ops,wd),/PAY_DISPUTE_NOT_FROZEN/);
 assert.equal(await balance(wu),100);
 report.checks.push('confirm lost after an early withdrawal is refused and takes nothing back');

 // Confirm and withdraw racing on one dispute: exactly one wins, the balance matches the winner.
 for(const confirmFirst of [true,false]) {
  const ru=await profile(0),rp=await pack(ru,100),rd=await receive(rp);
  await receive(rp,{type:'charge.dispute.closed',status:'lost'});
  const other=new pg.Client(c.connectionParameters);await other.connect();
  try {
   await c.query('BEGIN');
   if(confirmFirst) await confirm(ops,rd); else await withdraw(ops,rd);
   const racing=(confirmFirst?asService(()=>v('SELECT pay_dispute_withdraw($1,$2) v',[ops,rd.id],other),other)
    :confirm(ops,rd,other)).then(()=>null,e=>e);
   await new Promise(r=>setTimeout(r,300));
   await c.query('COMMIT');
   const lost=await racing;
   assert.match(String(lost?.message),confirmFirst?/PAY_DISPUTE_LOST_CONFIRMED/:/PAY_DISPUTE_NOT_FROZEN/);
   assert.equal(await balance(ru),confirmFirst?0:100);
  } finally {await c.query('ROLLBACK').catch(()=>{});await other.end();}
 }
 report.checks.push('confirm lost vs withdraw race: one winner under the shared dispute lock');

 // Waffo has no outcome feed: the admin confirms from the Waffo dashboard and the dispute closes as lost here.
 const xu=await profile(0),xp=await pack(xu,100),xd=await receive(xp);
 await c.query("UPDATE payment_disputes SET provider='waffo',status='under_review',closed_at=NULL,outcome=NULL WHERE id=$1",[xd.id]);
 await confirm(ops,xd);
 const xr=await row(xd);
 assert.equal(xr.status,'lost');assert.equal(xr.outcome,'lost');assert.ok(xr.closed_at);
 assert.equal(await balance(xu),0);
 report.checks.push('Waffo dispute confirmed lost without an outcome feed; status closes as lost');

 // Founder membership: frozen while open, ended with reason dispute_lost once confirmed; membership stays unpaid.
 const f=await member(start,end,'monthly','gold');
 await c.query("UPDATE payment_orders SET offer_kind='founder' WHERE id=$1",[f.order]);
 const fd=await receive(f,{subscriptionId:f.providerSub});
 const founder=()=>asService(()=>v('SELECT pay_founder_status($1) v',[f.user]));
 assert.equal((await founder()).state,'frozen');
 await receive(f,{type:'charge.dispute.closed',status:'lost',subscriptionId:f.providerSub});
 assert.equal((await founder()).state,'frozen');
 await confirm(ops,fd);
 const ended=await founder();
 assert.equal(ended.state,'ended');assert.equal(ended.endedReason,'dispute_lost');
 assert.equal(await v('SELECT membership_level v FROM profiles WHERE id=$1',[f.user]),'free');
 assert.equal(await v("SELECT count(*)::int v FROM payment_notices WHERE user_id=$1 AND kind='founder_ended'",[f.user]),0);
 report.checks.push('founder lost: identity ends as dispute_lost, membership stays free, no founder_ended email');
}
