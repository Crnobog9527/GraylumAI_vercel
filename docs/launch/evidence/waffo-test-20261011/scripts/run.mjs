/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { WaffoPancake } from '@waffo/pancake-ts';
const root = new URL('.', import.meta.url);
const env = parseEnv(fs.readFileSync(homedir() + '/.graylum/secrets/waffo-test.env', 'utf8'));
if (env.WAFFO_ENV !== 'test') throw new Error('Test mode required');
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /checkoutUrl|signature|token|secret|private|email|address|buyer|customer|cardInfo|phone|submitter/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  let out = value;
  for (const k of ['WAFFO_PRIVATE_KEY','WAFFO_MERCHANT_ID','WAFFO_STORE_ID']) out = out.split(env[k]).join(`[${k}]`);
  return out.replace(/#token=.*/g, '#[REDACTED]');
}
let label = 'preflight';
const allowed = new Set(['/v1/graphql','/v1/actions/subscription-product/create-product',
 '/v1/actions/checkout/create-session','/v1/actions/subscription-order/cancel-order',
 '/v1/actions/refund-ticket/create-ticket']);
const client = new WaffoPancake({merchantId:env.WAFFO_MERCHANT_ID,privateKey:env.WAFFO_PRIVATE_KEY,environment:'test',
 fetch:async(url,init)=> {
   const u=new URL(url);
   if (u.origin!=='https://api.waffo.ai'||!allowed.has(u.pathname)) throw new Error('Endpoint not permitted');
   const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(30000)});
   const envelope=await response.clone().json();
   fs.writeFileSync(new URL(`${label}.json`,root),JSON.stringify(redact({time:new Date().toISOString(),
     path:u.pathname,httpStatus:response.status,request:JSON.parse(init.body),response:envelope}),null,2)+'\n');
   return response;
 }});
const operationKey = (operation) => ['graylum', 'waffo', '20261011', operation].join('-');
const statePath=new URL('state.json',root);
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)): {products:{},sessions:{}};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state,null,2)+'\n');
const specs=[
 ['gold-intro','Gold monthly first 30 days USD49 then USD69','monthly','69.00','49.00'],
 ['gold-month','Gold monthly USD69','monthly','69.00'],
 ['gold-year','Gold yearly USD621','yearly','621.00'],
 ['founder-year','Founder yearly USD496','yearly','496.00'],
 ['pro-month','Pro monthly USD29','monthly','29.00'],
 ['pro-year','Pro yearly USD279','yearly','279.00']
];
try {
 const check=await client.graphql.query({query:`query($storeId:String!){
 store(id:$storeId){ id status isLive prodEnabled payinEnable }
 storeWebhooksCount(storeId:$storeId) }`,variables:{storeId:env.WAFFO_STORE_ID}});
 if(check.errors?.length||check.data?.store?.isLive!==false||check.data.store.id!==env.WAFFO_STORE_ID||
   check.data.store.prodEnabled!==false||check.data.storeWebhooksCount!==0) throw new Error('Preflight failed');
 const action=process.argv[2];
 if(action==='refund' || action==='cancel') {
   label='read-before-'+action;
   const q=await client.graphql.query({query:`query($storeId:String!){
    payments(filter:{storeId:{eq:$storeId},orderMerchantExternalId:{eq:breakpoint}}){
      id orderId status testMode amount {display currency} refundStatus
      subscriptionOrder {storeId status testMode orderMerchantExternalId} }
   }`.replace('breakpoint',JSON.stringify('graylum-waffo-20261011-'+(action==='refund'?'intro49':'monthly69'))),
    variables:{storeId:env.WAFFO_STORE_ID}});
   if(q.errors?.length||q.data?.payments?.length!==1)throw new Error('Original payment not unique');
   const p=q.data.payments[0];
   if(p.testMode!==true||p.status!=='succeeded'||p.subscriptionOrder.storeId!==env.WAFFO_STORE_ID||
     p.subscriptionOrder.testMode!==true)throw new Error('Payment scope invalid');
   if(action==='refund') {
     if(p.amount.display!=='49.00'||p.amount.currency!=='USD'||p.refundStatus!=='none')throw new Error('Refund scope invalid');
     label='refund-intro49';
     // SDK 0.26.0 lacks a public merchant refunds resource. Test-only internal transport.
     const result=await client.http.post('/v1/actions/refund-ticket/create-ticket',{
       paymentId:p.id,reason:'Owner-authorized test-mode evidence refund',requestedAmount:{amount:'49.00',currency:'USD'},
       refundTicketMerchantExternalId:'graylum-waffo-20261011-refund49'},
       {idempotencyKey:operationKey('refund49')});
     console.log(JSON.stringify(redact(result)));
   } else {
     if(p.subscriptionOrder.status!=='active')throw new Error('Cancellation already started or not active');
     label='cancel-monthly69';
     console.log(JSON.stringify(redact(await client.orders.cancelSubscription({orderId:p.orderId},
       {idempotencyKey:operationKey('cancel69')}))));
   }
 }
 if(action==='products') for(const [slug,name,billingPeriod,amount,trialAmount] of specs){
   if(state.products[slug]) continue;
   label=`product-${slug}`;
   const result=await client.subscriptionProducts.create({storeId:env.WAFFO_STORE_ID,
    name:`[Test 1011] ${name}`,billingPeriod,prices:{USD:{amount,taxCategory:'saas',...(trialAmount?{trialAmount}:{})}},
    metadata:{evidenceRun:'graylum-waffo-20261011',...(trialAmount?{trialDays:30}:{})}},
    {idempotencyKey:`graylum-waffo-20261011-product-${slug}`});
   state.products[slug]=result.product.id;save();console.log(slug,result.product.id);
 }
 if(action==='sessions'||action==='replay-expired') for(const [key,slug,ttl] of [
  ['intro49','gold-intro',86400],['monthly69','gold-month',86400],['annual496','founder-year',86400],['expired','pro-month',60]]){
   if(action==='replay-expired'&&key!=='expired')continue;
   if(action==='sessions'&&state.sessions[key])continue;
   label=action==='replay-expired'?'session-expired-replay':`session-${key}`;
   const result=await client.checkout.anonymous.create({productId:state.products[slug],currency:'USD',
    buyerEmail:'graylum-waffo-test-20261011@example.com',withTrial:key==='intro49',expiresInSeconds:ttl,
    orderMerchantExternalId:`graylum-waffo-20261011-${key}`,metadata:{orderId:`graylum-waffo-20261011-${key}`}},
    {idempotencyKey:`graylum-waffo-20261011-session-${key}`});
   if(action==='replay-expired'){
     console.log(JSON.stringify({sameSessionId:result.sessionId===state.sessions[key].sessionId,
       sameExpiry:result.expiresAt===state.sessions[key].expiresAt}));
   } else {state.sessions[key]=result;save();console.log(key,JSON.stringify(redact(result)));}
 }
} catch(e){ console.log(JSON.stringify({failed:true,type:e.name,status:e.status??null,errors:redact(e.errors??[])}));process.exitCode=1; }
