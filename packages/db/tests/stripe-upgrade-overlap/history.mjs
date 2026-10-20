/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {randomUUID} from 'node:crypto';

// Construct canonical HISTORICAL paid records in the disposable database. Frozen order fields
// cannot be time-shifted by UPDATE. Inserts run all the ordinary constraints and source guards.
export async function historyFixture(admin,{user,proSub,goldSub,proMonths,goldMonths=0}) {
  const actor=randomUUID(),ids=new Map(),orders=new Map();
  const balance=(await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits;
  await admin.query("INSERT INTO profiles(id,credits,membership_level) VALUES($1,$2,'gold')",[actor,balance]);
  for(const oldId of [proSub,goldSub]) {
    const sub=(await admin.query(`SELECT to_jsonb(s) v FROM user_subscriptions s WHERE id=$1`,[oldId])).rows[0].v;
    const order=(await admin.query(`SELECT to_jsonb(o) v FROM payment_orders o
      WHERE subscription_id=$1 AND fulfilled_at IS NOT NULL ORDER BY fulfilled_at LIMIT 1`,[oldId])).rows[0].v;
    const id=randomUUID(),orderId=randomUUID();ids.set(oldId,id);orders.set(oldId,orderId);
    const months=oldId===proSub?proMonths:goldMonths;
    const shift=async date=>(await admin.query('SELECT $1::timestamptz-make_interval(months=>$2) v',[date,months])).rows[0].v;
    await admin.query(`INSERT INTO user_subscriptions SELECT (jsonb_populate_record(NULL::user_subscriptions,$1)).*`,[
      {...sub,id,user_id:actor,current_period_start:await shift(sub.current_period_start),
        current_period_end:await shift(sub.current_period_end)},
    ]);
    await admin.query(`INSERT INTO payment_orders SELECT (jsonb_populate_record(NULL::payment_orders,$1)).*`,[
      {...order,id:orderId,user_id:actor,subscription_id:id,purchase_request_id:randomUUID(),
        source_order_id:oldId===goldSub?orders.get(proSub):null,
        method_prior_subscription:oldId===goldSub?ids.get(proSub):null,
        entitlement_start:await shift(order.entitlement_start),entitlement_end:await shift(order.entitlement_end)},
    ]);
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
      VALUES('stripe','fixture','test','payment',$1,$2)`,['in_history_'+orderId,orderId]);
    const grant=(await admin.query(`SELECT to_jsonb(g) v FROM subscription_credit_grants g WHERE subscription_id=$1`,[oldId])).rows[0].v;
    const key='payment:'+orderId+':01';
    const tx=(await admin.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_type,source_order_id,
      idempotency_key) VALUES($1,$2,'purchase','grant','payment_order',$3,$4) RETURNING id`,
    [actor,grant.credits_granted,orderId,key])).rows[0].id;
    await admin.query(`INSERT INTO subscription_credit_grants SELECT
      (jsonb_populate_record(NULL::subscription_credit_grants,$1)).*`,[
      {...grant,id:randomUUID(),user_id:actor,subscription_id:id,source_order_id:orderId,
        period_start:await shift(grant.period_start),period_end:await shift(grant.period_end),
        credit_transaction_id:tx,grant_period_key:key,idempotency_key:key},
    ]);
  }
  await admin.query('SELECT set_config($1,$2,true)',['request.jwt.claim.sub',actor]);
  return {actor,pro:ids.get(proSub),gold:ids.get(goldSub),proOrder:orders.get(proSub),balance};
}
