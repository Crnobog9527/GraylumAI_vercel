/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {decodeOpenRouterStreamObservation} from './openRouterEvidence';
import {openRouterBound} from './openRouterPolicy';
import {parseExactJson} from './decimal';
import {OPENROUTER_RESPONSE_BYTE_LIMIT as limit} from './responseCapacity';
import {mentorOutputFixture,mentorOutputWire,fullBudgetText} from '../__tests__/fixtures/mentorOutput';
import {normalizeOpenRouterHistory} from '../runtime/openRouterHistory';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',
 providerLimits:{providerSlug:'synthetic',contextTokens:40000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},
 outputLimit:32768,upperUsd:'0.08'} as const;
function input(stream:boolean){return {input:JSON.stringify({model:identity.model,stream,
 ...(stream?{stream_options:{include_usage:true}}:{}),store:false,messages:[],max_tokens:32768,
 provider:openRouterBound(identity.providerLimits,identity.outputLimit).routing})};}
it.each(['body','thinking','duplicated'] as const)('accepts exact full byte limit and rejects +1 byte/unit: %s',async mode=>{
 const fixture=mentorOutputFixture(mode==='duplicated');
 const response={...fixture.response,choices:[{...fixture.response.choices[0]!,message:mode==='thinking'?
  {role:'assistant',content:null,reasoning:fullBudgetText}:fixture.response.choices[0]!.message}]};
 for(const extra of [0,1,8]){
  response.usage.provider_metadata='';
  response.usage.provider_metadata='x'.repeat(limit-Buffer.byteLength(JSON.stringify(response))+extra);
  const raw=JSON.stringify(response);
  expect(Buffer.byteLength(raw)).toBe(limit+extra);
  for(const stream of [false,true]){
   // Keep usage frames within their independent bound by placing spare padding in text.
   const adjusted=structuredClone(response);
   if(stream&&Buffer.byteLength(JSON.stringify(adjusted.usage))>60000){
    const padding=adjusted.usage.provider_metadata;
    adjusted.usage.provider_metadata='';
    adjusted.choices[0]!.message.content=(adjusted.choices[0]!.message.content??'')+padding;
    // Replacing null with a string changes JSON overhead by two bytes.
    const delta=limit+extra-Buffer.byteLength(JSON.stringify(adjusted));
    adjusted.choices[0]!.message.content+='x'.repeat(Math.max(0,delta));
   }
   const expected=stream?adjusted:response;
   expect(Buffer.byteLength(JSON.stringify(expected))).toBe(limit+extra);
   const original=stream?mentorOutputWire(adjusted):raw;
   const transport=vi.fn(async()=>new Response(original));
   const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_ONLY',transport});
   const observed=await adapter.dispatch(input(stream),identity);
   const evidence=adapter.evidence(observed,identity,'response');
   if(extra===0){
    expect(evidence).toMatchObject({final:true,cost:'0.007',usage:{sdkResponse:expected}});
    expect(observed.rawBodyEncoding).toBe('gzip-base64');
    expect(decodeOpenRouterStreamObservation(observed).toString()).toBe(original);
    expect(evidence.sourceHash).toBe(createHash('sha256').update(original).digest('hex'));
    expect(adapter.evidence({...observed,rawBodySha256:'0'.repeat(64)},identity,'response').final).toBe(false);
   }else{
    expect(evidence.final).toBe(false);expect(evidence.cost).toBeNull();
    expect(evidence.usage).toBeNull();
   }
   expect(transport).toHaveBeenCalledTimes(1);
  }
 }
});
it('keeps default exact-number evidence at 64KiB; only complete response explicitly widens it',()=>{
 const raw='"'+'x'.repeat(65535)+'"';
 expect(()=>parseExactJson(raw)).toThrow('BILL2_EVIDENCE_TOO_LARGE');
 expect(parseExactJson(raw,limit)).toBe('x'.repeat(65535));
});
it.each(['summary','encrypted'] as const)('history accepts the new %s bound, rejects one character beyond',kind=>{
 for(const extra of [0,1]){
  const detail=kind==='summary'?{type:'reasoning.summary',format:'openai-responses-v1',summary:'x'.repeat(limit+extra)}:
   {type:'reasoning.encrypted',format:'openai-responses-v1',id:null,data:'x'.repeat(limit+extra)};
  const request={messages:[{role:'assistant',content:'kept',reasoning_details:[detail]}]};
  if(extra)expect(()=>normalizeOpenRouterHistory(request)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
  else{normalizeOpenRouterHistory(request);expect(request.messages).toEqual([{role:'assistant',content:'kept'}]);}
 }
});
