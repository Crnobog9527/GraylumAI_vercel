/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {it,expect} from 'vitest';
import {openRouterRejection} from './openRouterRejection';
import type {TransportObservation} from './fixtureAdapter';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1' as const};
const requestHash='a'.repeat(64);
function observation(body:unknown,stream=false):TransportObservation {
 const rawBody=typeof body==='string'?body:JSON.stringify(body),bytes=Buffer.from(rawBody);
 const sourceHash=createHash('sha256').update(bytes).digest('hex');
 return {rawBody,rawBodyBase64:bytes.toString('base64'),sourceHash,httpStatus:402,complete:true,transportIssue:null,
  ...(stream?{stream:true,rawBody:'',rawBodyBase64:gzipSync(bytes).toString('base64'),rawBodyEncoding:'gzip-base64',
   rawBodyByteLength:bytes.length,rawBodySha256:sourceHash,observedByteLength:bytes.length}:{})};
}
const error=(limit_source='openrouter_key_limit')=>({error:{code:402,message:'synthetic refusal',metadata:{limit_source}}});
it.each(['openrouter_key_limit','openrouter_credits','openrouter_in_flight_budget'])('accepts complete %s before generation',source=>{
 for(const stream of [false,true])expect(openRouterRejection(observation(error(source),stream),identity,requestHash))
  .toMatchObject({evidenceKind:'provider_rejection',cost:null,final:false,providerId:null,requestHash});
});
it.each([400,401,403,408,429,500,502,503,200])('never turns HTTP %s into a zero cost proof',httpStatus=>{
 expect(openRouterRejection({...observation(error()),httpStatus},identity,requestHash)).toBeNull();
});
it.each([
 {complete:false},{transportIssue:'body_timeout'},{transportIssue:'body_interrupted'},{generationId:'gen-1'},
 {sourceHash:'b'.repeat(64)},
])('rejects incomplete or contradictory transport %j',patch=>{
 expect(openRouterRejection({...observation(error()),...patch},identity,requestHash)).toBeNull();
});
it.each([
 {error:{code:402,message:'no metadata'}},error('unknown'),{...error(),id:'gen-1'},
 {...error(),usage:{cost:0}},{...error(),choices:[]},{...error(),output:[]},
 {error:{code:'402',metadata:{limit_source:'openrouter_key_limit'}}},
 '{"error":{"code":200,"code":402,"message":"x","metadata":{"limit_source":"openrouter_key_limit"}}}',
 'data: {"error":{"code":402}}\n\n',
])('rejects bodies without exclusive no-generation evidence %#',body=>{
 expect(openRouterRejection(observation(body),identity,requestHash)).toBeNull();
});

// Structural replay of the audited incident; every value is synthetic.
it('accepts audited harmless envelope fields without dropping financial guards',()=>{
 const body={...error(),user_id:'synthetic-user',error:{...error().error,
  metadata:{limit_source:'openrouter_key_limit',provider_name:null}}};
 for(const stream of [false,true]){
  expect(openRouterRejection(observation(body,stream),identity,requestHash)).toMatchObject({evidenceKind:'provider_rejection'});
  expect(openRouterRejection({...observation(body,stream),generationId:'gen-synthetic'},identity,requestHash)).toBeNull();
 }
 for(const value of [{...body,cost:0},{...body,usage:{}},{...body,output:[]},
  {...body,user_id:{usage:{cost:0}}},{...body,error:{...body.error,metadata:{...body.error.metadata,cost:0}}}]){
  expect(openRouterRejection(observation(value),identity,requestHash)).toBeNull();
 }
});
