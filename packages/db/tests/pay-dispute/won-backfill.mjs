/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHARGEBACK G2: withdrawing a won dispute re-releases the monthly credits paused during the hold. Local PostgreSQL only.
import assert from 'node:assert/strict';
import {addUtcMonths} from '../utc-months.mjs';

export async function wonBackfillCases({c,v,receive,withdraw,ops,report,member}) {
 const grants=order=>v('SELECT count(*)::int v FROM subscription_credit_grants WHERE source_order_id=$1',[order]);
 const balance=user=>v('SELECT credits v FROM profiles WHERE id=$1',[user]);
 const release=async()=>{await c.query('SET ROLE service_role');try{return await v('SELECT pay_waffo_release_due(500) v');}finally{await c.query('RESET ROLE');}};
 // A yearly member who started three months ago: only period 1 was released before the dispute.
 const start=addUtcMonths(new Date(Date.now()-60000),-3),end=addUtcMonths(start,12);
 const y=await member(start,end,'yearly','gold');
 assert.equal(await grants(y.order),1);assert.equal(await balance(y.user),100);
 const d=await receive(y,{subscriptionId:y.providerSub});
 assert.equal(await balance(y.user),0);
 // Periods 2-4 come due during the hold and are skipped by the regular release.
 await release();
 assert.equal(await grants(y.order),1);
 await receive(y,{type:'charge.dispute.closed',status:'won',subscriptionId:y.providerSub});
 const r=await withdraw(ops,d);
 assert.equal(r.restored,100);assert.equal(r.backfilled,300);assert.equal(r.status,'won');
 assert.equal(r.userId,y.user);assert.equal(r.orderId,y.order);
 assert.equal(await balance(y.user),400);assert.equal(await grants(y.order),4);
 // Original period dates are kept and nothing beyond what is due is released.
 const periods=(await c.query(`SELECT period_index,period_start,period_end FROM subscription_credit_grants
  WHERE source_order_id=$1 ORDER BY period_index`,[y.order])).rows;
 periods.forEach((p,n)=>{
  assert.equal(p.period_index,n+1);
  assert.equal(p.period_start.toISOString(),addUtcMonths(start,n).toISOString());
  assert.equal(p.period_end.toISOString(),addUtcMonths(start,n+1).toISOString());
 });
 assert.equal(await v('SELECT entitlement_end v FROM payment_orders WHERE id=$1',[y.order]).then(x=>x.toISOString()),end.toISOString());
 // Repeat withdrawal and the next maintenance run release nothing twice.
 assert.equal((await withdraw(ops,d)).duplicate,true);
 await release();
 assert.equal(await balance(y.user),400);assert.equal(await grants(y.order),4);
 report.checks.push('won withdrawal backfills paused periods on original dates exactly once; maintenance adds nothing');

 // A second open dispute on the same order keeps everything paused: no backfill until the last hold is gone.
 const z=await member(start,end,'yearly','gold');
 const z1=await receive(z,{subscriptionId:z.providerSub});
 await receive(z,{subscriptionId:z.providerSub,disputeId:'du_second_'+z.order.replaceAll('-','')});
 const zr=await withdraw(ops,z1);
 assert.equal(zr.backfilled,0);assert.equal(await grants(z.order),1);assert.equal(await balance(z.user),0);
 report.checks.push('no backfill while another dispute still holds the order');
}
