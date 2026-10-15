/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {recordLibraryProof} from './library-proof.mjs';

export async function runPaymentWrappers(db,report,{fresh,close,cleanup,begin,finish}) {
 const order=async(db,f,_metadata,o)=>{
  await db.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
   amount_total,currency,fulfilled_at,payment_channel,merchant_namespace,payment_mode,purchase_request_id,
   purchase_payload_hash,purchase_snapshot,checkout_request,payment_method,auto_renew,entitlement_term,
   routing_version,terms_version,terms_accepted_at,offer_kind,qualification_state,stripe_managed_payments)
   VALUES($1,$2,'membership_plan',$3,'monthly',$4,'completed','paid',1799,'usd',clock_timestamp(),$5,
    'synthetic','test',$6,$7,$8,$9,$10,$11,'month',1,'fixture',clock_timestamp(),'standard','sold',$12)`,
   [o.id,f.actor,o.snapshot.item_id,o.mode,o.channel,randomUUID(),'a'.repeat(64),o.snapshot,o.checkout,o.method,
    o.mode==='subscription',o.channel==='stripe'&&['card','card_cn'].includes(o.method)?o.method==='card':null]);
 };
 const fixture=async(kind='card')=>{
  const f=await fresh(db),id=randomUUID(),itemId=randomUUID();
  const method=kind==='waffo'?'card':kind;
  const metadata={orderId:id,userId:f.actor,itemId,itemType:'membership_plan',billingCycle:'monthly',priceId:'price_fixture'};
  const recurring=['card','card_cn','waffo'].includes(kind);
  const provider=kind==='waffo'
   ? {productId:'PROD_fixture',currency:'USD',withTrial:true,expiresInSeconds:1800,
    includePaymentMethods:['card'],orderMerchantExternalId:id,metadata:{orderId:id}}
   : {client_reference_id:f.actor,expires_at:1791331200,mode:recurring?'subscription':'payment',
    line_items:[{price:'price_fixture',quantity:1}],metadata,
    [recurring?'subscription_data':'payment_intent_data']:{metadata:structuredClone(metadata)},
    ...(kind==='card'?{managed_payments:{enabled:true},discounts:[{coupon:'coupon_fixture'}]}
     :{payment_method_types:[kind==='card_cn'?'card':kind]}),
    ...(kind==='card_cn'?{billing_address_collection:'required'}:{}),
    ...(kind==='wechat_pay'?{payment_method_options:{wechat_pay:{client:'web'}}}:{})};
  const safe={orderId:id,userId:f.actor,method,merchant:'synthetic',mode:'test',providerRequest:provider};
  const snapshot={version:1,item_type:'membership_plan',item_id:itemId,item_updated_at:'2026-10-07T00:00:00Z',
   billing_cycle:'monthly',currency:'usd',unit:'major',price:'19.99',discount:'2.00',tax_behavior:'unspecified',
   credits:100,bonus_credits:20};
  const options={id,snapshot,channel:kind==='waffo'?'waffo':'stripe',mode:recurring?'subscription':'payment',method};
  assert.deepEqual(await rpc(db,'erasure_payment_envelope',safe,'checkout'),safe,'fresh fixture independently valid');
  return {f,id,safe,options};
 };
 for(const kind of ['waffo','card','card_cn','wechat_pay','alipay']){
  const {f,id,safe,options}=await fixture(kind),provider=safe.providerRequest;
  const dirty={...safe,body:'PRIVATE',providerRequest:{...provider,buyerIdentity:'PRIVATE',successUrl:'PRIVATE',
   success_url:'PRIVATE',customer_email:'PRIVATE',metadata:{...provider.metadata,private:'PRIVATE'}}};
  await order(db,f,{}, {...options,checkout:dirty});
  const row=async()=>(await db.query('SELECT * FROM payment_orders WHERE id=$1',[id])).rows[0];
  const requestId=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  const before=await row();
  await recordLibraryProof(db,f);
  assert.deepEqual(await cleanup(db,f),{remaining:0,manualReview:0,errors:[]},kind+' wrapper completes cleanup');
  const after=await row();
  assert.deepEqual(after.checkout_request,safe);
  assert.doesNotMatch(JSON.stringify(after.checkout_request),/PRIVATE/);
  assert.ok(after.request_erased_at);
  const finance=r=>Object.fromEntries(Object.entries(r).filter(([k])=>
   !['checkout_request','purchase_change_request','request_erased_at'].includes(k)));
  assert.deepEqual(finance(after),finance(before),'all original financial columns unchanged');
  assert.deepEqual(await rpc(db,'erasure_payment_envelope',safe,'checkout'),safe,'projection idempotent');
  await assert.rejects(db.query('UPDATE payment_orders SET checkout_request=$2 WHERE id=$1',[id,dirty]),/ERASURE_ENVELOPE_REFILL/);
  assert.equal((await begin(db,f,requestId)).ready,true);
  assert.equal((await finish(db,f,requestId,true)).stage,'completed');
 }
 const rebind=(wrapper,key,value)=>{
  if(key==='orderId'||key==='userId')wrapper[key]=value;
  const p=wrapper.providerRequest;
  p.metadata[key]=value;p.subscription_data.metadata[key]=value;
  if(key==='userId')p.client_reference_id=value;
 };
 const malformed=[
  ['mode','card',w=>{w.mode='live';}],
  ['incomplete','card',w=>{w.providerRequest={mode:'payment'};}],
  ['contradictory method','card',w=>{w.method='wechat_pay';}],
  ['expiry','card',w=>{w.providerRequest.expires_at=null;}],
  ['provider user','card',w=>{w.providerRequest.metadata.userId=randomUUID();}],
  ['null items','card',w=>{w.providerRequest.line_items=null;}],
  ['null provider','card',w=>{w.providerRequest=null;}],
  ['unknown provider','card',w=>{w.providerRequest={unknown:true};}],
  ['quantity string','card',w=>{w.providerRequest.line_items[0].quantity='1';}],
  ['Waffo expiry string','waffo',w=>{w.providerRequest.expiresInSeconds='1800';}],
  ['Waffo trial type','waffo',w=>{w.providerRequest.withTrial='true';}],
 ];
 const crossRow=[
  ['other order','card',w=>rebind(w,'orderId',randomUUID())],
  ['other user','card',w=>rebind(w,'userId',randomUUID())],
  ['other item','card',w=>rebind(w,'itemId',randomUUID())],
  ['other merchant','card',w=>{w.merchant='other';}],
  ['row method','card',(_w,o)=>{o.method='card_cn';}],
  ['other Waffo order','waffo',w=>{const id=randomUUID();w.orderId=id;
   w.providerRequest.orderMerchantExternalId=id;w.providerRequest.metadata.orderId=id;}],
 ];
 for(const [name,kind,mutate] of [...malformed,...crossRow]){
  const {f,id,safe,options}=await fixture(kind);
  const invalid=structuredClone(safe);
  mutate(invalid,options);
  if(crossRow.some(test=>test[0]===name)){
   assert.deepEqual(await rpc(db,'erasure_payment_envelope',invalid,'checkout'),invalid,name+' is internally valid');
  }else{
   await assert.rejects(rpc(db,'erasure_payment_envelope',invalid,'checkout'),/ERASURE_/,name+' rejects at its intended predicate');
  }
  await order(db,f,{}, {...options,checkout:invalid});
  const requestId=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  await recordLibraryProof(db,f);
  const result=await cleanup(db,f);
  assert.ok(result.errors.includes('ERASURE_PAYMENT_REQUEST_REVIEW'),name);
  const saved=(await db.query('SELECT checkout_request,request_erased_at FROM payment_orders WHERE id=$1',[id])).rows[0];
  assert.deepEqual(saved.checkout_request,invalid,name+' retained');
  assert.equal(saved.request_erased_at,null);
  assert.equal((await begin(db,f,requestId)).ready,false);
 }
 report.checks.push('payment wrappers: five valid channel/method shapes complete; independent malformed and cross-row evidence stays blocked; privacy removed, finances unchanged');
}
