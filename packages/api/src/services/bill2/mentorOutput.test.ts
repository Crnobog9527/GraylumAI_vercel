/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
import {PURPOSE_OUTPUT_CAP} from '../runtime/purposeBudgets';
import {OPENROUTER_RESPONSE_BYTE_LIMIT} from './responseCapacity';
import {mentorOutputFixture} from '../__tests__/fixtures/mentorOutput';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',
 providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},
 outputLimit:PURPOSE_OUTPUT_CAP,upperUsd:'0.02'} as const;
it.each([false,true])('full response budget fits nonstream and stream with reasoning=%s',async reasoning=>{
 const {response,wire,generatedBytes}=mentorOutputFixture(reasoning);
 expect(Buffer.byteLength(JSON.stringify(response))).toBe(generatedBytes+8192);
 expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(OPENROUTER_RESPONSE_BYTE_LIMIT);
 const observations=[];
 for(const stream of [false,true]){
  const transport=vi.fn(async()=>new Response(stream?wire:JSON.stringify(response),{
   headers:{'content-type':stream?'text/event-stream':'application/json'}}));
  const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_ONLY',transport});
  const input=JSON.stringify({model:identity.model,stream,...(stream?{stream_options:{include_usage:true}}:{}),store:false,
   messages:[],max_tokens:PURPOSE_OUTPUT_CAP,provider:openRouterBound(identity.providerLimits,identity.outputLimit).routing});
  const observation=await adapter.dispatch({input},identity);
  expect(observation.complete).toBe(true);expect(observation.transportIssue).toBeNull();
  const evidence=adapter.evidence(observation,identity,'response');
  expect(evidence).toMatchObject({final:true,cost:'0.007',usage:{sdkResponse:response}});
  expect(transport).toHaveBeenCalledTimes(1);observations.push(evidence.usage);
 }
 expect(observations[0]).toEqual(observations[1]);
});
