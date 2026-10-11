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
 return ['card-original-month-end-anchor','card-leap-year-feb29','out-of-order-renewal-no-term-rewind','old-payment-no-second-grant'];
}
