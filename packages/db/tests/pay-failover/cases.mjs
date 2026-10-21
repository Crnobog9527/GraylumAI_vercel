/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {advancedCases} from './advanced.mjs';
import {disputeCases} from './disputes.mjs';
import {seedLegacyPurchase,legacyFailoverCases} from './legacy-admission.mjs';
export async function runCases({admin,service,connect}) {
 const cases=[];
 const actor=randomUUID(),normal=randomUUID(),disabled=randomUUID();
 await admin.query("INSERT INTO profiles(id,role,status) VALUES($1,'admin','active'),($2,'user','active'),($3,'admin','inactive')",[actor,normal,disabled]);
 const legacy=await seedLegacyPurchase({admin,service});
 const routes={version:1,card:{enabled:true},card_cn:{enabled:true},wechat_pay:{enabled:true,annualVerified:true},alipay:{enabled:true,annualVerified:true}};
 await admin.query("INSERT INTO system_settings(key,value) VALUES('payment_method_routes',$1)",[routes]);
 const current=async()=>(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
 const switchTo=async(channel,version,user=actor)=>(await service.query(
  'SELECT pay_failover_set_channel($1,$2,$3) v',[user,version??(await current()).version,channel])).rows[0].v;
 await assert.rejects(()=>switchTo('waffo',1,normal),/ADMIN_REQUIRED/);
 await assert.rejects(()=>switchTo('waffo',1,disabled),/ADMIN_REQUIRED/);
 await assert.rejects(()=>service.query("UPDATE system_settings SET value=value||'{\"newPurchaseChannel\":\"waffo\",\"version\":2}' WHERE key='payment_method_routes'"),/RPC_REQUIRED/);
 const second=await connect();await second.query('SET ROLE service_role');
 const switching=await Promise.allSettled([switchTo('waffo',1),second.query("SELECT pay_failover_set_channel($1,1,'waffo')",[actor])]);
 assert.equal(switching.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await current()).version,2);
 assert.equal((await current()).newPurchaseChannel,'waffo');
 assert.equal((await switchTo('waffo')).version,2,'same selected channel is a harmless no-op');
 assert.equal((await admin.query("SELECT count(*)::int n FROM user_activity_logs WHERE admin_id=$1 AND action='pay_failover_set_channel'",[actor])).rows[0].n,1);
 await switchTo('stripe');await switchTo('waffo');
 assert.equal((await current()).version,4);
 cases.push('admin-only-active','ordinary-setting-channel-bypass-denied','concurrent-version-conflict','bidirectional-audit-and-noop');
 const plan=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
  allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
  ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760 RETURNING id`)).rows[0].id;
 const gold=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
  allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Gold','gold',6900,62100,8970,107640,false,false,0)
  ON CONFLICT(level) DO UPDATE SET monthly_price=6900,yearly_price=62100,monthly_credits=8970,yearly_credits=107640 RETURNING id`)).rows[0].id;
 for(const channel of ['stripe','waffo'])for(const item of [plan,gold])for(const cycle of ['monthly','yearly'])
  for(const usage of ['one_time','subscription'])for(const offer of (item===gold&&cycle==='yearly'?['standard','founder']:['standard'])){
   await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES($1,'fixture','test','price',$2,$3,$4,true,$5,$6)`,
    [channel,`PROD_${randomUUID().replaceAll('-','')}`,item,cycle,offer,usage]);
  }
 const create=async({user,item=plan,cycle='monthly',method='card',offer='standard',transition=null,prior=null,mode='test',db=service}={})=>{
  if(!user){user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);}
  const version=(await current()).version;
  const digests=JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}]);
  if(transition)return(await db.query(`SELECT o.* FROM pay_waffo_create_transition($1,$2,$3,$4,$5,
   'fixture',$6,'terms-v1',$7,$8,$9,$10) o`,[user,item,cycle,method,offer,version,digests,transition,prior,mode])).rows[0];
  return(await db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,
   'fixture',$8,$6,'terms-v1',$7) o`,[user,item,cycle,method,offer,version,digests,mode])).rows[0];
 };
 const bind=async o=>{
  const expiry=new Date(Date.now()+1800000),checkout=`checkout_${o.id}`;
  const product=(await admin.query('SELECT external_id FROM payment_provider_refs WHERE id=$1',[o.price_ref_id])).rows[0].external_id;
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[o.user_id,o.id,'fixture',
   {orderId:o.id,userId:o.user_id,method:o.payment_method,merchant:'fixture',mode:o.payment_mode,purchaseMode:'payment',
    providerRequest:{productId:product,currency:'USD',withTrial:false,buyerIdentity:'a'.repeat(64),
     orderMerchantExternalId:o.id,metadata:{orderId:o.id},expiresInSeconds:1800,successUrl:'https://example.test/app/profile',priceSnapshot:{amount:(o.amount_total/100).toFixed(2),taxIncluded:true,taxCategory:'saas'}}},expiry]);
  await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[o.user_id,o.id,'fixture',checkout,expiry]);
  return checkout;
 };
 const pay=async(o,{db=service,method='card',paid=new Date(Math.floor(Date.now()/1000)*1000),start=paid,checkout=`checkout_${o.id}`,review}={})=>{
  const end=new Date(start);if(o.billing_cycle==='yearly')end.setUTCFullYear(end.getUTCFullYear()+1);else end.setUTCMonth(end.getUTCMonth()+1);
  const args=[o.id,'fixture',checkout,`PAY_${o.id}`,method,o.amount_total,'usd',paid,start,end];
  if(review!==undefined)args.push(review);
  return(await db.query('SELECT pay_failover_fulfill('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).rows[0].v;
 };
 cases.push(...await legacyFailoverCases({admin,service,connect,actor,legacy,current,switchTo,create,bind}));
 const first=await create();assert.equal(first.purchase_snapshot.tax_behavior,'inclusive','Waffo one-time price is tax inclusive');assert.equal(first.payment_channel,'waffo');assert.equal(first.mode,'payment');assert.equal(first.auto_renew,false);
 await assert.rejects(()=>admin.query("UPDATE payment_orders SET provider_payment_method='card' WHERE id=$1",[first.id]),/WRITE_DENIED/);
 await bind(first);
 const two=await connect();await two.query('SET ROLE service_role');
 const paid=await Promise.all([pay(first),pay(first,{db:two})]);
 assert.equal(paid.filter(p=>p.duplicate===false).length,1);
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[first.user_id])).rows[0].credits,3480);
 assert.equal((await service.query('SELECT pay_common_membership_facts($1) v',[first.user_id])).rows[0].v.internal_membership.purchase_mode,'payment');
 await assert.rejects(()=>pay(first,{method:'alipay'}),/METHOD_CONFLICT/);
 assert.equal((await admin.query('SELECT count(*)::int n FROM payment_provider_refs WHERE subscription_id=(SELECT subscription_id FROM payment_orders WHERE id=$1)',[first.id])).rows[0].n,0);
 cases.push('membership-facts-identify-waffo-one-time-mode','waffo-card-one-time-only','actual-method-direct-write-denied','concurrent-duplicate-grants-once','actual-method-frozen','no-waffo-subscription-created');
 const unknown=await create({method:'alipay'});await bind(unknown);
 assert.equal((await pay(unknown,{method:'unknown'})).state,'review');
 assert.equal((await pay(unknown,{method:'unknown'})).state,'review');
 const reviewed=(await admin.query('SELECT qualification_state,payment_status,payment_amount_facts,provider_payment_method,fulfilled_at FROM payment_orders WHERE id=$1',[unknown.id])).rows[0];
 assert.equal(reviewed.payment_status,'paid');assert.equal(reviewed.qualification_state,'review');assert.equal(reviewed.payment_amount_facts.length,1);
 assert.equal(reviewed.provider_payment_method,null);assert.equal(reviewed.fulfilled_at,null);
 assert.equal((await pay(unknown,{method:'alipay'})).state,'review','later known field still needs manual resolution');
 cases.push('unknown-method-cash-preserved-no-grant','unknown-replay-not-duplicated');
 const renewal=await create({user:first.user_id,cycle:'yearly',transition:'wallet_renewal',prior:paid.find(p=>p.subscriptionId)?.subscriptionId});
 await bind(renewal);
 const original=(await admin.query('SELECT entitlement_end FROM payment_orders WHERE id=$1',[first.id])).rows[0].entitlement_end;
 assert.equal((await pay(renewal,{start:original})).state,'fulfilled');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[first.user_id])).rows[0].credits,3480,'future annual releases no credits early');
 cases.push('waffo-yearly-renewal-appends-term','future-renewal-does-not-grant-early');
 // A pending identity survives both route directions and blocks creating a second provider charge.
 const unresolved=await create();await bind(unresolved);await switchTo('stripe');
 await assert.rejects(()=>create({user:unresolved.user_id,method:'alipay'}),/PURCHASE_PENDING/);
 assert.equal((await create({user:unresolved.user_id})).id,unresolved.id);
 assert.equal((await pay(unresolved)).state,'fulfilled','old Waffo payment still completes after return to Stripe');
 const stripe=await create({method:'alipay'});assert.equal(stripe.purchase_snapshot.tax_behavior,'exclusive','Stripe tax contract unchanged');assert.equal(stripe.payment_channel,'stripe');assert.equal(stripe.auto_renew,false);
 const card=await create();assert.equal(card.payment_channel,'stripe');assert.equal(card.auto_renew,true);
 await switchTo('waffo');
 cases.push('pending-payment-blocks-cross-provider-charge','waffo-old-order-fulfills-after-switchback','stripe-new-wallet-and-recurring-card-restored');
 cases.push(...await advancedCases({admin,service,connect,actor,create,bind,pay,current,switchTo,plan,gold,first}));
 cases.push(...await disputeCases({admin,service,actor,create,bind,pay}));
 return cases;
}
