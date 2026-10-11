/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function calendarCases({admin,service}) {
 const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
 const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
 const order=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card',
  'standard','fixture','test',1,'terms-v1',$3) o`,[user,plan,JSON.stringify([{kind:'email',key_version:'test-v1',digest:'e'.repeat(64)}])])).rows[0];
 await admin.query("UPDATE payment_orders SET created_at='2024-01-31T12:00:00Z' WHERE id=$1",[order.id]);
 const checkout=`calendar_${order.id}`;
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
  VALUES('waffo','fixture','test','checkout',$1,$2)`,[checkout,order.id]);
 const initial=(await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,6900,'usd','2024-01-31T12:00:00Z',
  $4,'2024-01-31T12:00:00Z','2024-02-29T12:00:00Z') v`,[order.id,checkout,`payment_${order.id}`,`ORD_${order.id}`])).rows[0].v;
 const renew=async(key,start,end)=>(await service.query(`SELECT pay_waffo_renew_subscription($1,'fixture',$2,6900,'usd',$3,$3,$4) v`,
  [initial.subscriptionId,`payment_${order.id}_${key}`,start,end])).rows[0].v;
 await renew('april','2024-04-30T12:00:00Z','2024-05-31T12:00:00Z');
 await renew('feb','2024-02-29T12:00:00Z','2024-03-31T12:00:00Z');
 await renew('mar','2024-03-31T12:00:00Z','2024-04-30T12:00:00Z');
 assert.equal((await renew('feb','2024-02-29T12:00:00Z','2024-03-31T12:00:00Z')).duplicate,true);
 assert.equal((await admin.query('SELECT current_period_end FROM user_subscriptions WHERE id=$1',[initial.subscriptionId])).rows[0].current_period_end.toISOString(),
  '2024-05-31T12:00:00.000Z','out-of-order historical payment never rewinds current term');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,35880);
 await assert.rejects(()=>renew('bad','2024-05-31T12:00:00Z','2024-06-29T12:00:00Z'),/RENEW_CONFLICT/);
 // Gold first 30 days (PR #815 validation): the paid term is exactly Waffo's currentPeriodStart/End, and the
 // first renewal must start at that same instant, so there is no unpaid day between the two periods.
 const intro=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[intro]);
 const first=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card',
  'gold_first30','fixture','test',1,'terms-v1',$3) o`,[intro,plan,JSON.stringify([{kind:'email',key_version:'test-v1',
  digest:randomUUID().replaceAll('-','').repeat(2)}])])).rows[0];
 assert.equal(first.entitlement_term,'days30');
 await admin.query("UPDATE payment_orders SET created_at='2024-03-10T16:49:00Z' WHERE id=$1",[first.id]);
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
  VALUES('waffo','fixture','test','checkout',$1,$2)`,[`intro_${first.id}`,first.id]);
 await assert.rejects(()=>service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,4900,'usd','2024-03-10T16:49:49Z',
  $4,'2024-03-10T16:49:49Z','2024-04-10T16:49:49Z')`,[first.id,`intro_${first.id}`,`payment_${first.id}_x`,`ORD_${first.id}`]),
  /TERM_INVALID/,'a 31-day first term is refused, never silently granted');
 const paid=(await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,4900,'usd','2024-03-10T16:49:49Z',
  $4,'2024-03-10T16:49:49Z','2024-04-09T16:49:49Z') v`,[first.id,`intro_${first.id}`,`payment_${first.id}`,`ORD_${first.id}`])).rows[0].v;
 assert.equal(paid.state,'fulfilled');
 const introRenew=async(key,start,end)=>(await service.query(`SELECT pay_waffo_renew_subscription($1,'fixture',$2,6900,'usd',$3,$3,$4) v`,
  [paid.subscriptionId,`payment_${first.id}_${key}`,start,end])).rows[0].v;
 await assert.rejects(()=>introRenew('late','2024-04-10T16:49:49Z','2024-05-10T16:49:49Z'),/RENEW_CONFLICT/,
  'a renewal period that leaves a gap is not accepted as a normal renewal');
 assert.equal((await introRenew('next','2024-04-09T16:49:49Z','2024-05-09T16:49:49Z')).state,'fulfilled');
 const terms=(await admin.query(`SELECT entitlement_start,entitlement_end FROM payment_orders WHERE subscription_id=$1
  AND payment_status='paid' ORDER BY entitlement_start`,[paid.subscriptionId])).rows.map(r=>[r.entitlement_start.toISOString(),r.entitlement_end.toISOString()]);
 assert.deepEqual(terms,[['2024-03-10T16:49:49.000Z','2024-04-09T16:49:49.000Z'],['2024-04-09T16:49:49.000Z','2024-05-09T16:49:49.000Z']],
  'first-30 term and first renewal are contiguous');
 return ['card-original-month-end-anchor','card-leap-year-feb29','out-of-order-renewal-no-term-rewind','old-payment-no-second-grant',
  'gold-first30-term-is-provider-period','gold-first30-renewal-contiguous'];
}
