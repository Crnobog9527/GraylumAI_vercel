/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function invoiceCases({admin}) {
  await admin.query('BEGIN');
  try {
    await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel',
      jsonb_build_object('channel','stripe','version',coalesce((SELECT (value->>'version')::int FROM system_settings
        WHERE key='payment_new_purchase_channel'),0)+1)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const plan=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,monthly_credits,monthly_bonus_credits,
      yearly_price,yearly_credits,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES('Invoice fixture','pro',1999,100,20,19999,1205,false,false,0)
      ON CONFLICT(level) DO UPDATE SET monthly_price=1999,monthly_credits=100,monthly_bonus_credits=20,
        yearly_price=19999,yearly_credits=1205 RETURNING id`)).rows[0].id;
    const cases=[];
    for(const cycle of ['monthly','yearly']) {
      const user=randomUUID(), orders=[];
      await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
      const start='2026-10-01T00:00:00.000Z',end=cycle==='monthly'?'2026-11-01T00:00:00.000Z':'2027-10-01T00:00:00.000Z';
      const credits=cycle==='monthly'?120:101,cents=cycle==='monthly'?1999:19999;
      const external=`sub_collision_${cycle}`,invoice=`in_collision_${cycle}`,key=cycle==='monthly'?`invoice:${invoice}`:`annual:${start}:01`;
      for(const [merchant,mode] of [['invoice_fixture','test'],['invoice_fixture','live'],['invoice_other','test']]) {
        const price=(await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
          membership_plan_id,billing_cycle,is_current) VALUES('stripe',$1,$2,'price',$3,$4,$5,true) RETURNING id`,
        [merchant,mode,`price_collision_${cycle}`,plan,cycle])).rows[0].id;
        let order;
        if(orders.length) {
          // Synthetic pre-existing intent; never a live admission or provider call.
          order=(await admin.query('INSERT INTO payment_orders SELECT (jsonb_populate_record(NULL::payment_orders,$1)).* RETURNING *',
            [{...orders[0].order,id:randomUUID(),merchant_namespace:merchant,payment_mode:mode,price_ref_id:price,
              purchase_request_id:randomUUID()}])).rows[0];
        }
        await admin.query('SET LOCAL ROLE service_role');
        if(!order) order=(await admin.query("SELECT * FROM pay_common_create_purchase($1,'membership_plan',$2,$3,$4,$5,'free')",
          [user,plan,cycle,merchant,mode])).rows[0];
        const evidence={id:`cs_collision_${cycle}`,object:'checkout.session',livemode:mode==='live',mode:'subscription',
          client_reference_id:user,metadata:{orderId:order.id,userId:user,itemId:plan,itemType:'membership_plan',
            billingCycle:cycle,priceId:`price_collision_${cycle}`},amount_total:cents,currency:'usd',
          payment_status:'paid',status:'complete',invoice};
        assert.equal((await admin.query('SELECT pay_common_record_checkout($1,$2,$3,$4) r',
          [order.id,merchant,mode,evidence])).rows[0].r.ok,true);
        const grant=()=>admin.query(`SELECT * FROM atomic_grant_subscription_invoice_credits(
          p_user_id=>$1::uuid,p_membership_plan_id=>$2,p_stripe_subscription_id=>$3,p_stripe_invoice_id=>$4,
          p_source_order_id=>$5,p_amount_total=>$6,p_grant_period_key=>$7,p_period_start=>$8,p_period_end=>$9,
          p_credits_granted=>$10,p_billing_cycle=>$11,p_membership_level=>'pro',p_grant_type=>$12,
          p_period_index=>$13,p_total_periods=>$14,p_idempotency_key=>'same-external-invoice-event',
          p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId',$1::text))`,
        [user,plan,external,invoice,order.id,cents,key,start,end,credits,cycle,
          cycle==='monthly'?'monthly_invoice':'annual_monthly_release',cycle==='monthly'?null:1,cycle==='monthly'?1:12]);
        const first=(await grant()).rows[0]; assert.equal(first.granted,true); assert.equal(first.credits_granted,credits);
        assert.equal((await grant()).rows[0].is_idempotent,true);
        if(cycle==='yearly') {
          const release=()=>admin.query(`SELECT * FROM atomic_grant_annual_subscription_credits(
            p_user_id=>$1::uuid,p_membership_plan_id=>$2,p_stripe_subscription_id=>$3,p_stripe_invoice_id=>$4,
            p_source_order_id=>$5,p_grant_period_key=>'annual:2026-10-01T00:00:00.000Z:02',
            p_period_start=>'2026-11-01',p_period_end=>'2026-12-01',p_period_index=>2,p_total_periods=>12,
            p_credits_granted=>101,p_idempotency_key=>'same-annual-period-event',p_description=>'fixture',
            p_source_type=>'stripe_invoice',p_source_id=>$4,p_now=>'2026-11-01')`,[user,plan,external,invoice,order.id]);
          assert.equal((await release()).rows[0].granted,true); assert.equal((await release()).rows[0].is_idempotent,true);
        }
        orders.push({order,grant:first.grant_id});
        await admin.query('RESET ROLE');
      }
      assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,
        credits*3*(cycle==='yearly'?2:1));
      assert.equal((await admin.query('SELECT count(DISTINCT subscription_id)::int n FROM subscription_credit_grants WHERE user_id=$1',[user])).rows[0].n,3);
      assert.equal((await admin.query(`SELECT count(*)::int n FROM subscription_credit_grants g
        JOIN user_subscriptions s ON s.user_id=g.user_id AND s.id<>g.subscription_id
        WHERE g.user_id=$1 AND pay_waffo_canonical_grant(s,g)`,[user])).rows[0].n,0);
      await admin.query('SET LOCAL ROLE service_role');
      await admin.query('SAVEPOINT legacy');
      await assert.rejects(()=>admin.query("SELECT * FROM atomic_refund_termination_clawback_fresh($1,$2,'same-event','2026-10-15')",
        [user,external]),/REFUND_SCOPE_REQUIRED/);
      await admin.query('ROLLBACK TO SAVEPOINT legacy');
      for(const {order,grant} of orders) {
        const refund=()=>admin.query(`SELECT * FROM pay_waffo_atomic_refund_termination_clawback_fresh(
          $1,$2,$3,'same-event','2026-10-15',NULL,'stripe_refund','same-refund','2026-10-15')`,[order.id,user,external]);
        const first=(await refund()).rows[0]; assert.equal(first.applied_clawback_amount,credits);
        assert.equal(first.review_required,false); assert.equal((await refund()).rows[0].already_applied,true);
        assert.equal((await admin.query('SELECT status FROM subscription_credit_grants WHERE id=$1',[grant])).rows[0].status,'reversed');
      }
      await admin.query('RESET ROLE');
      assert.equal((await admin.query("SELECT count(*)::int n FROM credit_transactions WHERE user_id=$1 AND ledger_type='refund_clawback'",[user])).rows[0].n,3);
      cases.push(`${cycle}-real-invoice-mode-merchant-isolation`,`${cycle}-scoped-grant-and-refund-replay`);
    }
    return [...cases,'ambiguous-legacy-refund-fails-closed','scoped-annual-period-release'];
  } finally {await admin.query('ROLLBACK');}
}
