/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import type {Session} from '@openai/agents';
import {createHash} from 'node:crypto';
import {runRuntime} from './runner';
import {openRouterRequestBody} from './providerRequest';
import {freezePromptCache,PROMPT_CACHE_OVERHEAD_BYTES} from './promptCache';
import {selectRuntimeCallInput,assertRuntimeRequestCapacity} from './context';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
const model='anthropic/test';
const instructions='技能正文\n固定系统规则\n\n当前问题';
const limits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
 requestUsd:'0',cacheWriteUsdPerMillion:'2.5'};
const quote=openRouterBound(limits,100);
const policy={modelId:'10000000-0000-4000-8000-000000000001',provider:'openrouter' as const,account:'synthetic',model,
 protocol:'openrouter-chat-v1' as const,upperUsd:quote.upperUsd,inputLimit:10000,outputLimit:100,
 automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true,providerLimits:limits};
const promptCache=freezePromptCache({real:true,role:'skill',model,instructions,skillChars:4,
 stableAdditionalChars:8,cacheWriteUsdPerMillion:limits.cacheWriteUsdPerMillion})!;
const context={providerRequestFormat:'serial-tools-v2' as const,tools:[],network:'deny',promptCache};
const session=():Session=>({getSessionId:async()=> 'synthetic-session',getItems:async()=>[],
 addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}});

it.each([
 {cached_tokens:0,cache_write_tokens:100,cost:0.00035,cache_discount:-0.00005},
 {cached_tokens:100,cache_write_tokens:0,cost:0.00012,cache_discount:0.00018},
])('SDK → frozen bytes → adapter → receipt uses official net cost: %j',async usageDetails=>{
 const usage={prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:usageDetails.cost,
  cache_discount:usageDetails.cache_discount,prompt_tokens_details:{cached_tokens:usageDetails.cached_tokens,
   cache_write_tokens:usageDetails.cache_write_tokens}};
 const reply={id:'gen-cache-test',object:'chat.completion',created:1,model,
  choices:[{index:0,message:{role:'assistant',content:'Synthetic reply'},finish_reason:'stop'}],usage};
 const transport=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(reply)));
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC',transport});
 const hashes:string[]=[];
 for(let replay=0;replay<2;replay++)await runRuntime({model,instructions,input:'Synthetic input',session:session(),
  maxOutputTokens:100,maxTurns:1,tools:[],selectHistory:async(_history,incoming)=>incoming,
  exchange:async(_sequence,request)=>{
   const wire=openRouterRequestBody(request,{context,policy,phase:'skill',primaryDialogue:true});
   assertRuntimeRequestCapacity(wire,policy.inputLimit);
   hashes.push(createHash('sha256').update(wire).digest('hex'));
   const sent=JSON.parse(wire);
   expect(sent.messages[0].content[0].cache_control).toEqual({type:'ephemeral'});
   expect(sent.messages[0].content.map((part:{text:string})=>part.text).join('')).toBe(instructions);
   if(replay)return JSON.stringify(reply); // Cached runtime_response: no second dispatch.
   const evidence=adapter.evidence(await adapter.dispatch({input:wire},policy),policy,'response');
   expect(Number(evidence.cost)).toBe(usage.cost);
   expect(evidence.final).toBe(true);
   expect(evidence.usage).toMatchObject({sdkResponse:{usage}});
   expect(Number(evidence.cost)).toBeLessThan(Number(policy.upperUsd));
   return evidence.rawBody;
  },
 });
 expect(hashes[0]).toBe(hashes[1]);expect(transport).toHaveBeenCalledTimes(1);
});

it('accounts for marker overhead before trimming at the exact selection boundary',()=>{
 const incoming={role:'user',content:'new'},history={role:'user',content:'old'.repeat(200)};
 const items=[history,incoming];
 const oldSize=Buffer.byteLength(JSON.stringify({instructions,messages:items}))+128;
 const without=selectRuntimeCallInput(items,1,{instructions,inputBytes:oldSize,toolBytes:0});
 const withCache=selectRuntimeCallInput(items,1,{instructions,inputBytes:oldSize,toolBytes:PROMPT_CACHE_OVERHEAD_BYTES});
 expect(without).toHaveLength(2);expect(withCache).toEqual([incoming]);
 const wire=openRouterRequestBody(JSON.stringify({model,messages:[{role:'system',content:instructions},...withCache],
  max_tokens:100,stream:false,store:false}),{context,policy,phase:'skill',primaryDialogue:true});
 expect(()=>assertRuntimeRequestCapacity(wire,oldSize)).not.toThrow();
 expect(()=>assertRuntimeRequestCapacity(wire,Buffer.byteLength(wire))).not.toThrow();
 expect(()=>assertRuntimeRequestCapacity(wire,Buffer.byteLength(wire)-1)).toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
});
