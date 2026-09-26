/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import type {AgentInputItem,Session} from '@openai/agents';
import {runRuntime} from './runner';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
it('official SDK read_source roundtrip passes opt-in official transport without enabling web search',async()=>{
 const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
 const requests:Record<string,unknown>[]=[];let reads=0;const history:AgentInputItem[]=[];
 const session:Session={getSessionId:async()=> 'synthetic-session',getItems:async()=>history,addItems:async items=>{history.push(...items);},popItem:async()=>undefined,clearSession:async()=>{history.length=0;}};
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)));
  const message=requests.length===1?{role:'assistant',content:null,tool_calls:[{id:'source-1',type:'function',function:{name:'read_source',arguments:'{}'}}]}:{role:'assistant',content:'I used the relevant source.'};
  return new Response(JSON.stringify({id:'gen-'+requests.length,object:'chat.completion',created:1,model:identity.model,choices:[{index:0,message,finish_reason:requests.length===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.001}}));
 }});
 const result=await runRuntime({model:identity.model,instructions:'Read when relevant',input:'Use my topic',session,maxTurns:2,maxOutputTokens:100,tools:[{name:'read_source',description:'Read relevant owned source',execute:async()=>{reads++;return 'owned source';}}],selectHistory:async(history,incoming)=>[...history,...incoming],exchange:async(_sequence,body)=>{
  const original=JSON.parse(body);const observation=await adapter.dispatch({input:JSON.stringify({...original,stream:false,provider:openRouterBound(identity.providerLimits,100).routing})},identity);return observation.rawBody;
 }});
 expect(result).toBe('I used the relevant source.');expect(reads).toBe(1);expect(requests).toHaveLength(2);expect(JSON.stringify(requests[1])).toContain('owned source');
});
