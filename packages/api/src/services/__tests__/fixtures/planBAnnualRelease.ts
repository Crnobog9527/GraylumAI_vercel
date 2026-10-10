/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {randomUUID} from 'node:crypto';
import type pg from 'pg';

/** Real test-mode payment/grant RPCs in the disposable database; no provider calls. */
export async function annualReleaseFixture(db: pg.Client, actor: string) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const afterNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1)).toISOString();
  const namespace = 'r13-' + randomUUID(), invoice = 'in_' + randomUUID().replaceAll('-', ''), subscription = 'sub_' + randomUUID().replaceAll('-', '');
  const price = 'price_' + randomUUID().replaceAll('-', ''), checkout = 'cs_' + randomUUID().replaceAll('-', '');
  await db.query(`insert into membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    values('Plan B fixture','pro',false,false,0) on conflict(level) do nothing`);
  const original = (await db.query("select * from membership_plans where level='pro'")).rows[0];
  const priorChannel = (await db.query("select value from system_settings where key='payment_new_purchase_channel'")).rows[0]?.value;
  const restore = async () => {
    await db.query('update membership_plans set yearly_price=$2,yearly_credits=$3,monthly_bonus_credits=$4,is_active=$5 where id=$1',
      [original.id, original.yearly_price, original.yearly_credits, original.monthly_bonus_credits, original.is_active]);
    // The guarded setting cannot be deleted or have its version rewound; absent means default waffo.
    await db.query(`update system_settings set value=jsonb_build_object('channel',$1::text,
      'version',(value->>'version')::bigint+1) where key='payment_new_purchase_channel'`, [priorChannel?.channel ?? 'waffo']);
  };
  try {
    await db.query("update membership_plans set yearly_price=1999,yearly_credits=1205,monthly_bonus_credits=0,is_active='true' where id=$1", [original.id]);
    await db.query(`insert into payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current) values('stripe',$1,'test','price',$2,$3,'yearly',true)`, [namespace, price, original.id]);
    await db.query(`insert into system_settings(key,value) select 'payment_new_purchase_channel',
      jsonb_build_object('channel','stripe','version',coalesce((select (value->>'version')::bigint
      from system_settings where key='payment_new_purchase_channel'),0)+1)
      on conflict(key) do update set value=jsonb_build_object('channel','stripe',
      'version',(system_settings.value->>'version')::bigint+1)`);
    const order = (await db.query("select (pay_common_create_purchase($1,'membership_plan',$2,'yearly',$3,'test','free')).id",
      [actor, original.id, namespace])).rows[0].id;
    await db.query("select pay_common_record_checkout($1,$2,'test',$3)", [order, namespace,
      {id: checkout, object: 'checkout.session', livemode: false, mode: 'subscription', client_reference_id: actor,
        metadata: {orderId: order, userId: actor, itemId: original.id, itemType: 'membership_plan', billingCycle: 'yearly', priceId: price},
        amount_total: 1999, currency: 'usd', payment_status: 'paid', status: 'complete', invoice}]);
    await db.query(`select * from atomic_grant_subscription_invoice_credits(
      p_metadata=>$1,p_user_id=>$2,p_membership_plan_id=>$3,p_stripe_subscription_id=>$4,p_stripe_invoice_id=>$5,
      p_source_order_id=>$6,p_amount_total=>1999,p_grant_period_key=>$8,
      p_billing_cycle=>'yearly',p_grant_type=>'annual_monthly_release',p_period_index=>1,p_total_periods=>12,
      p_period_start=>$9,p_period_end=>$10,p_credits_granted=>101,
      p_membership_level=>'pro',p_idempotency_key=>$7)`,
    [{stripeSubscriptionStatus: 'active', stripeSubscriptionUserId: actor}, actor, original.id, subscription, invoice, order, namespace + '-first',
      'annual:' + start + ':01', start, end]);
    const release = async (client: pg.Client) => (await client.query(`select * from atomic_grant_annual_subscription_credits(
      p_user_id=>$1,p_membership_plan_id=>$2,p_stripe_subscription_id=>$3,p_stripe_invoice_id=>$4,p_source_order_id=>$5,
      p_grant_period_key=>$7,p_period_start=>$8,
      p_period_end=>$9,p_period_index=>2,p_total_periods=>12,p_credits_granted=>101,
      p_idempotency_key=>$6,p_description=>'Plan B monthly release',p_source_type=>'stripe_invoice',p_source_id=>$4,
      p_now=>$8)`, [actor, original.id, subscription, invoice, order, namespace + '-second', 'annual:' + start + ':02', next, afterNext])).rows[0];
    return {release, restore};
  } catch (error) {await restore(); throw error;}
}
