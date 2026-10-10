/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function scopeCases({admin}) {
  await admin.query('BEGIN');
  try {
    await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel',
      jsonb_build_object('channel','stripe','version',coalesce((SELECT (value->>'version')::int FROM system_settings
        WHERE key='payment_new_purchase_channel'),0)+1)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const pack=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
      VALUES('scope fixture',990,100,20,'true') RETURNING id`)).rows[0].id;
    const orders=[];
    for (const [merchant,mode] of [['acct_fixture','test'],['acct_fixture','live'],['acct_other','test']]) {
      const buyer=randomUUID();
      await admin.query("INSERT INTO profiles(id,membership_level) VALUES($1,'free')",[buyer]);
      const price=(await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
        credit_package_id,billing_cycle,is_current) VALUES('stripe',$1,$2,'price','price_scoped',$3,'one_time',true) RETURNING id`,[merchant,mode,pack])).rows[0].id;
      // Live here is a synthetic pre-existing row, never a live admission/provider call.
      let order;
      if(mode==='live') order=(await admin.query(`INSERT INTO payment_orders
        SELECT (jsonb_populate_record(NULL::payment_orders,$1)).* RETURNING *`,[{...orders[0].order,
          id:randomUUID(),user_id:buyer,payment_mode:mode,price_ref_id:price,purchase_request_id:randomUUID()}])).rows[0];
      await admin.query('SET LOCAL ROLE service_role');
      if(!order) order=(await admin.query("SELECT * FROM pay_common_create_purchase($1,'credit_package',$2,'one_time',$3,$4,'free')",
        [buyer,pack,merchant,mode])).rows[0];
      const metadata={orderId:order.id,userId:buyer,itemId:pack,itemType:'credit_package',billingCycle:'one_time',priceId:'price_scoped'};
      const request={mode:'payment',client_reference_id:buyer,customer_creation:'always',expires_at:Math.floor(Date.now()/1000)+3600,
        metadata,line_items:[{quantity:1,price:'price_scoped'}]};
      await admin.query('SELECT pay_common_prepare_checkout($1,$2,$3)',[buyer,order.id,request]);
      const evidence={id:'cs_same_scoped',object:'checkout.session',livemode:mode==='live',mode:'payment',client_reference_id:buyer,
        metadata,amount_total:990,currency:'usd',payment_status:'paid',status:'complete'};
      const outcome=(await admin.query('SELECT pay_common_record_checkout($1,$2,$3,$4) AS result',[order.id,merchant,mode,evidence])).rows[0].result;
      assert.equal(outcome.ok,true,JSON.stringify(outcome));
      orders.push({order,buyer,merchant,mode});
      await admin.query('RESET ROLE');
    }
    // Assert denials through savepoints: a rejected RPC must not poison the test transaction.
    const denied=async(args)=>{
      await admin.query('SAVEPOINT denial');
      await assert.rejects(()=>admin.query(...args),/CHECKOUT_MAPPING_UNKNOWN/);
      await admin.query('ROLLBACK TO SAVEPOINT denial');
    };
    await admin.query('SET LOCAL ROLE service_role');
    await denied(["SELECT * FROM atomic_fulfill_credit_package('cs_same_scoped','paid')"]);
    await denied(["SELECT * FROM atomic_fulfill_credit_package('cs_same_scoped','paid','acct_other','live')"]);
    for(const {order,buyer,merchant,mode} of orders) {
      const args=['cs_same_scoped','paid',merchant,mode];
      const call=()=>admin.query('SELECT * FROM atomic_fulfill_credit_package($1,$2,$3,$4)',args);
      const first=(await call()).rows[0];
      assert.equal(first.order_id,order.id); assert.equal(first.user_id,buyer); assert.equal(first.granted_credits,120);
      assert.equal((await call()).rows[0].granted_credits,0);
    }
    await admin.query('RESET ROLE');
    for(const {buyer} of orders) {
      assert.equal((await admin.query("SELECT count(*)::int n FROM credit_transactions WHERE user_id=$1 AND type='purchase'",[buyer])).rows[0].n,1);
    }
    return ['same-checkout-record-test-live-merchant','scoped-package-grant-once','unscoped-ambiguous-grant-denied','wrong-scope-denied'];
  } finally {await admin.query('ROLLBACK');}
}
