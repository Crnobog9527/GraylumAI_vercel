/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { WaffoPancake, verifyWebhook } from '@waffo/pancake-ts';
const sourceBlobs = {
  'pr791-client.ts': 'cbe7f2584256bbc391a274a4799d1981eaaddcc5',
  'pr791-webhook.ts': '4a87b23fd3021cb01f8524c3152d0340d237b94a',
};
// Check immutable GitHub blobs BEFORE importing or attributing any test result.
for (const [name, expected] of Object.entries(sourceBlobs)) {
  const content = fs.readFileSync(new URL(name, import.meta.url));
  const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  assert.equal(actual, expected, 'Compared source does not match the attributed GitHub blob');
}
const { createWaffoTestOperationsClient } = await import('./pr791-client.ts');
const { verifyWaffoReceipt } = await import('./pr791-webhook.ts');
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,
 privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const now=Date.now(); const originalNow=Date.now; Date.now=()=>now;
const merchantId='MER_0000000000000000000001',storeId='STO_0000000000000000000001',orderId='ORD_0000000000000000000001';
let oldRequest,sdkRequest;
const response=()=>new Response(JSON.stringify({data:{orderId,status:'canceling'}}),{status:200});
const old=createWaffoTestOperationsClient({merchant:'fixture',merchantId,storeId,privateKey},async(url,init)=>{
 oldRequest={url,init};return response();});
const sdk=new WaffoPancake({merchantId,privateKey,environment:'test',fetch:async(url,init)=>{
 sdkRequest={url,init};return response();}});
await old.cancelSubscription(orderId);await sdk.orders.cancelSubscription({orderId});
assert.equal(oldRequest.url,sdkRequest.url);assert.equal(oldRequest.init.body,sdkRequest.init.body);
assert.deepEqual(oldRequest.init.headers,sdkRequest.init.headers);
const results=[{case:'request signature exact-byte parity (ephemeral fixture key)',passed:true}];
const event={eventType:'subscription.payment_succeeded',eventId:'fixture.2026-10-11T06:00:00.000Z',
 storeId,mode:'test',data:{orderId,paymentId:'PAY_0000000000000000000001'}};
const body=JSON.stringify(event);
const sign=(t)=>`t=${t},v1=${createSign('RSA-SHA256').update(`${t}.${body}`).sign(privateKey,'base64')}`;
const oldVerify=(payload,signature)=>verifyWaffoReceipt({body:Buffer.from(payload),signature,publicKey,storeId,merchantNamespace:'fixture',now});
const sdkVerify=(payload,signature)=>verifyWebhook(payload,signature,{publicKey,environment:'test'});
for (const [name,payload,sig] of [['valid',body,sign(now)],['tampered',body+' ',sign(now)],
 ['old46min',body,sign(now-46*60*1000)],['future61sec',body,sign(now+61000)],
 ['spacedHeader',body,sign(now).replace(',v1=',', v1=')]]){
 const run=(f)=>{try {const r=f(payload,sig);return {accepted:true,...('requiresLookup'in r?{requiresLookup:r.requiresLookup}:{})};}
 catch{return {accepted:false};}};
 results.push({case:name,pr791:run(oldVerify),sdk:run(sdkVerify)});
}
Date.now=originalNow;
assert.equal(results[1].pr791.accepted,true);assert.equal(results[1].sdk.accepted,true);
assert.equal(results[2].pr791.accepted,false);assert.equal(results[2].sdk.accepted,false);
assert.equal(results[3].pr791.requiresLookup,true);assert.equal(results[3].sdk.accepted,false);
assert.equal(results[4].pr791.accepted,false);assert.equal(results[4].sdk.accepted,false);
assert.equal(results[5].pr791.accepted,false);assert.equal(results[5].sdk.accepted,true);
const output={kind:'LOCAL_SYNTHETIC_NOT_PROVIDER_WEBHOOK',pr791Head:'d931f0302647dde634facec7bea77b1d6f91176d',
 sdk:'0.26.0',sourceBlobs,testCases:6,results};
fs.writeFileSync(new URL('signing-test.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
