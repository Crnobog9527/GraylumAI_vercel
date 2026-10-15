/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
import {recordLibraryProof} from './library-proof.mjs';

export async function runPaymentWrappers(db,report,{fresh,order,close,cleanup,begin,finish}) {
 const stripe={mode:'subscription',line_items:[{price:'price_fixture',quantity:1}],
  managed_payments:{enabled:true},discounts:[{coupon:'coupon_fixture'}],
  metadata:{orderId:'order_fixture'},subscription_data:{metadata:{orderId:'order_fixture'}}};
 const waffo={productId:'PROD_fixture',currency:'USD',withTrial:true,expiresInSeconds:1800,
  includePaymentMethods:['card'],orderMerchantExternalId:'order_fixture',metadata:{orderId:'order_fixture'}};
 const wallet={mode:'payment',payment_method_types:['wechat_pay'],line_items:[{price:'price_fixture',quantity:1}],
  payment_method_options:{wechat_pay:{client:'web'}}};
 for (const [provider,method] of [[waffo,'card'],[stripe,'card'],[wallet,'wechat_pay']]) {
  const f=await fresh(db);
  const safe={orderId:'order_fixture',userId:f.actor,method,merchant:'synthetic',mode:'test',providerRequest:provider};
  const dirty={...safe,body:'PRIVATE',providerRequest:{...provider,buyerIdentity:'PRIVATE',successUrl:'PRIVATE',
   success_url:'PRIVATE',customer_email:'PRIVATE',metadata:{...provider.metadata,private:'PRIVATE'}}};
  const expected={...safe,providerRequest:{...provider,metadata:provider.metadata??{}}};
  const id=await order(db,f,{}, {checkout:dirty});
  const row=async()=>(await db.query('SELECT * FROM payment_orders WHERE id=$1',[id])).rows[0];
  const requestId=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  const before=await row();
  await recordLibraryProof(db,f);
  assert.deepEqual(await cleanup(db,f),{remaining:0,manualReview:0,errors:[]},method+' wrapper completes cleanup');
  const after=await row();
  assert.deepEqual(after.checkout_request,expected);
  assert.doesNotMatch(JSON.stringify(after.checkout_request),/PRIVATE/);
  assert.ok(after.request_erased_at);
  const finance=r=>Object.fromEntries(Object.entries(r).filter(([k])=>
   !['checkout_request','purchase_change_request','request_erased_at'].includes(k)));
  assert.deepEqual(finance(after),finance(before),'all original financial columns unchanged');
  assert.deepEqual(await rpc(db,'erasure_payment_envelope',expected,'checkout'),expected,'projection idempotent');
  await assert.rejects(db.query('UPDATE payment_orders SET checkout_request=$2 WHERE id=$1',[id,dirty]),/ERASURE_ENVELOPE_REFILL/);
  assert.equal((await begin(db,f,requestId)).ready,true);
  assert.equal((await finish(db,f,requestId,true)).completed,true);
 }
 const wrapper={orderId:'order_fixture',userId:'user_fixture',method:'card',merchant:'synthetic',mode:'test',providerRequest:waffo};
 for (const invalid of [
  {...wrapper,mode:'live'}, {...wrapper,providerRequest:null}, {...wrapper,providerRequest:{unknown:true}},
  {...wrapper,providerRequest:{...waffo,expiresInSeconds:'1800'}},
  {...wrapper,providerRequest:{...waffo,withTrial:'true'}},
  {...wrapper,providerRequest:{...stripe,line_items:[{quantity:'1'}]}},
 ]) {
  const f=await fresh(db),id=await order(db,f,{}, {checkout:invalid});
  const requestId=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  await recordLibraryProof(db,f);
  const result=await cleanup(db,f);
  assert.ok(result.errors.includes('ERASURE_PAYMENT_REQUEST_REVIEW'));
  const saved=(await db.query('SELECT checkout_request,request_erased_at FROM payment_orders WHERE id=$1',[id])).rows[0];
  assert.deepEqual(saved.checkout_request,invalid);
  assert.equal(saved.request_erased_at,null);
  assert.equal((await begin(db,f,requestId)).ready,false);
 }
 report.checks.push('payment wrappers: Waffo, Stripe card/coupon and WeChat cleanup complete; privacy removed, financial facts unchanged, malformed evidence blocked');
}
