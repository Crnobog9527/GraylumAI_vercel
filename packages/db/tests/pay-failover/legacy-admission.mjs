/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Create a real pre-activation Stripe intent; method-routing activation must never rewrite it. */
export async function seedLegacyPurchase({admin,service}) {
 const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
 await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel',
  '{"channel":"stripe","version":1}')`);
 const item=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits)
  VALUES('Legacy failover fixture',990,990,0) RETURNING id`)).rows[0].id;
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
  credit_package_id,billing_cycle,is_current,price_usage)
  VALUES('stripe','legacy_fixture','test','price',$1,$2,'one_time',true,'package')`,[`price_legacy_${randomUUID()}`,item]);
 const buy=async(db=service,buyer=user)=>(await db.query(`SELECT o.* FROM pay_common_create_purchase(
  $1,'credit_package',$2,'one_time','legacy_fixture','test','free') o`,[buyer,item])).rows[0];
 return {user,item,buy,order:await buy()};
}

export async function legacyFailoverCases({admin,service,connect,actor,legacy,current,switchTo,create,bind}) {
 const source=(await admin.query(`SELECT pg_get_functiondef(
  'public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text)'::regprocedure) source`)).rows[0].source;
 assert.match(source,/PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED/);
 assert.ok(source.includes('pg_advisory_xact_lock_shared(7063, 2)'),
  '0204 already serializes the legacy admission with the current failover route lock');
 assert.equal((await current()).newPurchaseChannel,'waffo');
 const fresh=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[fresh]);
 const frozen=(o)=>({id:o.id,channel:o.payment_channel,request:o.purchase_request_id,
  hash:o.purchase_payload_hash,snapshot:o.purchase_snapshot,price:o.price_ref_id});
 await assert.rejects(()=>legacy.buy(service,fresh),/PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED/);
 assert.deepEqual(frozen(await legacy.buy()),frozen(legacy.order),'an original Stripe intent is still recoverable during Waffo emergency');
 const pending=await create();await bind(pending);
 await assert.rejects(()=>legacy.buy(service,pending.user_id),/PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED/);
 assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[pending.user_id])).rows[0].n,1,
  'unknown Waffo cash cannot acquire an independently payable Stripe order through the old entry');
 await switchTo('stripe');
 await assert.rejects(()=>legacy.buy(service,fresh),/PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED/,
  'switchback does not weaken the existing method/terms activation guard');
 assert.deepEqual(frozen(await legacy.buy()),frozen(legacy.order));
 const controller=await connect(),recoverer=await connect(),newBuyer=await connect();
 for(const db of [controller,recoverer,newBuyer])await db.query('SET ROLE service_role');
 await controller.query('BEGIN');
 try {
  await controller.query("SELECT pay_failover_set_channel($1,$2,'waffo')",[actor,(await current()).version]);
  const resumed=legacy.buy(recoverer);
  const denied=legacy.buy(newBuyer,fresh).then(()=>({ok:true}),error=>({ok:false,message:error.message}));
  const waiting=[recoverer.processID,newBuyer.processID];let blocked=false;
  for(let attempt=0;attempt<30;attempt++){
   const rows=(await admin.query(`SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity
    WHERE pid=ANY($1::int[])`,[waiting])).rows;
   blocked=rows.length===2&&rows.every(row=>row.blockers.includes(controller.processID));
   if(blocked)break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(blocked,true,'both recovery and fresh legacy admission wait for the same versioned failover lock');
  await controller.query('COMMIT');
  assert.deepEqual(frozen(await resumed),frozen(legacy.order));
  assert.match((await denied).message,/PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED/);
 } finally {await controller.query('ROLLBACK');}
 assert.equal((await admin.query("SELECT value->>'channel' channel FROM system_settings WHERE key='payment_new_purchase_channel'")).rows[0].channel,'stripe');
 assert.equal((await current()).newPurchaseChannel,'waffo');
 assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[fresh])).rows[0].n,0);
 return ['legacy-global-stripe-cannot-bypass-waffo-method-routing','legacy-frozen-stripe-intent-remains-recoverable',
  'legacy-entry-cannot-double-charge-waffo-pending','stripe-switchback-keeps-method-and-terms-activation-guard',
  'legacy-admission-and-recovery-share-failover-lock'];
}
