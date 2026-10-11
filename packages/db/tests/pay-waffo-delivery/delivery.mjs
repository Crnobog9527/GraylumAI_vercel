/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function deliveryCases({admin,service,connect}) {
  const plan=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Gold','gold',6900,62100,8970,107640,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=6900,yearly_price=62100,monthly_credits=8970,yearly_credits=107640 RETURNING id`)).rows[0].id;
  const routes={version:1,card:{enabled:true},wechat_pay:{enabled:true,annualVerified:true},alipay:{enabled:true,annualVerified:true}};
  await admin.query("INSERT INTO system_settings(key,value) VALUES('payment_method_routes',$1)",[routes]);
  for(const [channel,cycle,offer] of [['stripe','monthly','standard'],['stripe','yearly','standard'],['waffo','monthly','gold_first30']])
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current,offer_kind) VALUES($1,'fixture','test','price',$2,$3,$4,true,$5)`,
    [channel,`price_${channel}_${cycle}_${offer}`,plan,cycle,offer]);
  const fixture=async(cycle='monthly',method='alipay',offer='standard')=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,
      'fixture','test',1,'terms-v1',$6) o`,[user,plan,cycle,method,offer,
      JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}])])).rows[0];
    const request={orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}};
    const expiry=new Date(Date.now()+1800000);
    const claim=async(u=user,m='fixture')=>(await service.query(
      'SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5) v',[u,o.id,m,request,expiry])).rows[0].v;
    await assert.rejects(()=>claim(randomUUID()),/ACCOUNT_CLOSED|CHECKOUT_DENIED/);
    await assert.rejects(()=>claim(user,'wrong'),/CHECKOUT_DENIED/);
    assert.equal((await claim()).dispatch,true); assert.equal((await claim()).dispatch,false);
    const checkout=`checkout_${o.id}`;
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
    return {o,user,checkout};
  };
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  for(const [cycle,method,offer] of [['monthly','alipay','standard'],['yearly','alipay','standard'],['monthly','card','gold_first30']]) {
    const {o,user,checkout}=await fixture(cycle,method,offer);
    const start=new Date(Math.floor(Date.now()/1000)*1000);
    if(method==='card') { start.setUTCDate(start.getUTCDate()-32); await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,start]); }
    const end=new Date(start);
    if(offer==='gold_first30') end.setUTCDate(end.getUTCDate()+30);
    else if(cycle==='yearly') end.setUTCFullYear(end.getUTCFullYear()+1);
    else end.setUTCMonth(end.getUTCMonth()+1);
    const args=[o.id,'fixture',checkout,`payment_${o.id}`,o.amount_total,'usd',start,method==='card'?`sub_${o.id}`:null,start,end];
    const pay=async(db=service,a=args)=>(await db.query('SELECT pay_waffo_fulfill_payment('+a.map((_,i)=>'$'+(i+1)).join(',')+') v',a)).rows[0].v;
    await assert.rejects(()=>pay(service,[...args.slice(0,4),1,...args.slice(5)]),/PAYMENT_FACT_MISMATCH/);
    const results=await Promise.all([pay(one),pay(two)]);
    assert.equal(results.filter(r=>r.duplicate===false).length,1);
    assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,8970);
    assert.equal((await admin.query('SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1',[o.id])).rows[0].n,1);
    await service.query('SELECT pay_waffo_release_due(100)');
    assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,8970);
    if(method==='card') {
      const subscription=results[0].subscriptionId ?? results[1].subscriptionId;
      const renewalEnd=new Date(end);renewalEnd.setUTCMonth(renewalEnd.getUTCMonth()+1);
      const payment=`renew_${o.id}`,paid=new Date(Math.floor(Date.now()/1000)*1000);
      const renew=async(db)=>(await db.query(`SELECT pay_waffo_renew_subscription($1,'fixture',$2,6900,'usd',$3,$4,$5) v`,
        [subscription,payment,paid,end,renewalEnd])).rows[0].v;
      const recurring=await Promise.all([renew(one),renew(two)]);
      assert.equal(recurring.filter(r=>r.duplicate===false).length,1);
      assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,17940);
    }
  }
  for(const closed of [false,true]) {
    const {o,user,checkout}=await fixture();
    const start=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(start);
    end.setUTCMonth(end.getUTCMonth()+1);
    if(closed) await admin.query("UPDATE profiles SET is_deleted='true' WHERE id=$1",[user]);
    else await service.query("SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,'closed_unpaid',NULL,0,'usd',NULL)",[o.id,checkout]);
    const applied=(await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,6900,'usd',$4,NULL,$4,$5) v`,
      [o.id,checkout,`payment_${o.id}`,start,end])).rows[0].v;
    assert.equal(applied.state,'review');
    const profile=(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[user])).rows[0];
    assert.equal(profile.credits,0); assert.equal(profile.membership_level,'free');
    assert.equal((await admin.query('SELECT payment_status FROM payment_orders WHERE id=$1',[o.id])).rows[0].payment_status,'paid');
  }
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>service.query('SELECT pay_waffo_release_due(100)'),/permission denied/);
  }
  return ['schema-idempotency','checkout-one-dispatch','cross-user-denied','cross-merchant-denied','wrong-amount-denied',
    'concurrent-payment-one-grant','wallet-month-delivery','wallet-year-first-grant','card-first30-delivery','card-renewal-69-after-49','card-renewal-payment-dedup','release-idempotency','client-rpc-denied','late-released-payment-no-entitlement','closed-account-financial-only'];
}
