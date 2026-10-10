/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function admissionCases({ admin, service, connect }) {
  const makeUser = async () => {
    const id = randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)', [id]); return id;
  };
  const plan = (await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Gold','gold',6900,62100,8970,107640,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=6900,yearly_price=62100,monthly_credits=8970,yearly_credits=107640 RETURNING id`)).rows[0].id;
  for (const channel of ['stripe','waffo']) for (const [offer,cycle] of [
    ['standard','monthly'],['gold_first30','monthly'],['founder','yearly'],
  ]) {
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current,offer_kind) VALUES($1,'fixture','test','price',$2,$3,$4,true,$5)`,
    [channel,`price_${channel}_${offer}`,plan,cycle,offer]);
  }
  const digests = (digest = 'c'.repeat(64)) => [{kind:'email',key_version:'test-v1',digest}];
  const buy = (db,user,opts={}) => db.query(`SELECT o.* FROM pay_waffo_create_purchase(
    $1,'membership_plan',$2,$3,$4,$5,'fixture',$6,$7,'terms-v1',$8) o`,
  [user,plan,opts.cycle??'monthly',opts.method??'wechat_pay',opts.offer??'gold_first30',
    opts.mode??'test',opts.version??3,JSON.stringify(digests(opts.digest))]);
  const buyer=await makeUser();
  await assert.rejects(()=>buy(service,buyer),/SALES_DISABLED/);
  const routes={version:3,card:{enabled:true},wechat_pay:{enabled:true,annualVerified:false},
    alipay:{enabled:true,annualVerified:true}};
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[routes]);
  await assert.rejects(()=>buy(service,buyer,{mode:'live'}),/LIVE_DISABLED/);
  await assert.rejects(()=>buy(service,buyer,{version:2}),/VERSION_CONFLICT/);
  await assert.rejects(()=>buy(service,buyer,{cycle:'yearly',offer:'founder'}),/ANNUAL_UNVERIFIED/);
  await admin.query('UPDATE membership_plans SET monthly_price=3900 WHERE id=$1',[plan]);
  await assert.rejects(()=>buy(service,buyer),/CATALOG_NOT_READY/);
  await admin.query('UPDATE membership_plans SET monthly_price=6900 WHERE id=$1',[plan]);
  const a=await makeUser(),b=await makeUser();
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  // Hold the real identity lock, observe both database sessions waiting before release.
  const lock=`gold_purchase:test:email:test-v1:${'c'.repeat(64)}`;
  await admin.query('BEGIN');
  await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const first=buy(one,a),second=buy(two,b);
  let blocked=false;
  for(let n=0;n<100;n++) {
    const pending=await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT o.* FROM pay_waffo_create_purchase%'");
    if(pending.rows[0].n===2) {blocked=true;break;}
    await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(blocked,'both first-Gold admissions waited on the identity barrier');
  await admin.query('COMMIT');
  const results=await Promise.allSettled([first,second]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,results.map(r=>r.reason?.message).join(';'));
  assert.match(results.find(r=>r.status==='rejected').reason.message,/GOLD_FIRST_INELIGIBLE/);
  const order=results.find(r=>r.status==='fulfilled').value.rows[0];
  assert.equal(order.amount_total,4900); assert.equal(order.mode,'payment'); assert.equal(order.auto_renew,false);
  assert.equal(order.entitlement_term,'days30'); assert.equal(order.stripe_subscription_id,null);
  assert.equal((await buy(service,order.user_id)).rows[0].id,order.id);
  await assert.rejects(()=>buy(service,order.user_id,{method:'card'}),/PURCHASE_PENDING/);
  await assert.rejects(()=>service.query('UPDATE payment_orders SET qualification_state=\'released\' WHERE id=$1',[order.id]),
    /permission denied/);
  // Provider refs isolate the exact same external ID in test and live, and in another merchant.
  for(const [mode,merchant] of [['live','fixture'],['test','other']]) {
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,offer_kind) VALUES('waffo',$1,$2,'price','price_waffo_standard',$3,'monthly','standard')`,
    [merchant,mode,plan]);
  }
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','fixture','test','checkout','checkout_first',$1)`,[order.id]);
  const observe=(state,payment=null,amount=0,paidAt=null)=>service.query(
    "SELECT pay_waffo_observe_qualification($1,'fixture','test','checkout_first',$2,$3,$4,'usd',$5) AS state",
    [order.id,state,payment,amount,paidAt]);
  await assert.rejects(()=>observe('open'),/PAYMENT_FACT_MISMATCH/);
  assert.equal((await observe('closed_unpaid')).rows[0].state,'released');
  assert.equal((await observe('paid','payment_late',4900,new Date())).rows[0].state,'review');
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[order.user_id])).rows[0].membership_level,'free');
  // Fifty cross-method historical slots; refund/status edits do not return a sold slot.
  for(let n=0;n<49;n++) {
    const user=await makeUser();
    await buy(service,user,{method:n%2?'card':'alipay',offer:'founder',cycle:'yearly',digest:n.toString(16).padStart(64,'0')});
  }
  await admin.query('BEGIN'); await admin.query('SELECT pg_advisory_xact_lock(7063,3)');
  const c=await makeUser(),d=await makeUser();
  // Users must be visible before independent connections enter the barrier.
  await admin.query('COMMIT');
  await admin.query('BEGIN'); await admin.query('SELECT pg_advisory_xact_lock(7063,3)');
  const final1=buy(one,c,{method:'card',offer:'founder',cycle:'yearly',digest:'e'.repeat(64)});
  const final2=buy(two,d,{method:'alipay',offer:'founder',cycle:'yearly',digest:'f'.repeat(64)});
  blocked=false;
  for(let n=0;n<100;n++) {
    const pending=await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT o.* FROM pay_waffo_create_purchase%'");
    if(pending.rows[0].n===2) {blocked=true;break;}
    await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(blocked); await admin.query('COMMIT');
  const final=await Promise.allSettled([final1,final2]);
  assert.equal(final.filter(r=>r.status==='fulfilled').length,1,final.map(r=>r.reason?.message).join(';'));
  assert.match(final.find(r=>r.status==='rejected').reason.message,/FOUNDER_SOLD_OUT/);
  assert.equal((await admin.query("SELECT count(*)::int n FROM payment_orders WHERE offer_kind='founder'")).rows[0].n,50);
  return ['default-off','live-denied','stale-version','wallet-annual-gate','old-catalog-denied',
    'first-gold-identity-concurrency','wallet-days30','pending-method-switch-denied','protected-reservation',
    'reference-mode-and-merchant-isolation','verified-release','late-payment-review','founder-50-concurrency'];
}
