/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import type {AgentInputItem,Session} from '@openai/agents';
import {projectOpenRouterItemsForSizing} from './openRouterHistory';
import {openRouterRequestBody} from './providerRequest';
import {runRuntime,type RuntimeTool} from './runner';
import {selectRuntimeHistory,selectRuntimeCallInput,assertRuntimeRequestCapacity} from './context';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';

// Response shapes observed on staging on 2026-10-11 (synthetic text and ids):
// Sonnet numbers its single tool call (`index: 0`); Gemini signs completed text
// with a `google-gemini-v1` thought signature that carries no text.
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const policy={...identity,modelId:'10000000-0000-4000-8000-000000000001',inputLimit:6000,automaticRetry:false as const,
 hiddenTools:false as const,lookupSupported:true,upperUsd:openRouterBound(identity.providerLimits,100).upperUsd};
const context={providerRequestFormat:'serial-tools-v6-reasoning' as const,reasoning:{effort:'low' as const},
 tools:['read_source'],workspaceContext:true,network:'deny'};
const sizing={instructions:'Use synthetic sources',inputBytes:6000,historyItems:30,toolBytes:600,
 projectItemsForSizing:(items:unknown[],count:number)=>projectOpenRouterItemsForSizing(items,count)};
const sourceCall={id:'toolu_synthetic',type:'function',function:{name:'read_source',arguments:'{"query": ""}'}};
const geminiSignature=[{type:'reasoning.text',format:'google-gemini-v1',index:0,signature:'SYNTHETIC_SIGNATURE'}];
const completion=(n:number,message:Record<string,unknown>,finish='stop')=>JSON.stringify({id:'gen-'+n,object:'chat.completion',created:1,
 model:identity.model,choices:[{index:0,message:{role:'assistant',refusal:null,reasoning:null,...message},finish_reason:finish}],
 usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}});
const tools:RuntimeTool[]=[{name:'read_source',description:'Read an owned source.',execute:async()=>JSON.stringify({body:'Synthetic source'})}];

function conversation(replies:Array<Record<string,unknown>>){
 const history:AgentInputItem[]=[],sent:Array<{messages:Array<Record<string,unknown>>}>=[];
 const session:Session={getSessionId:async()=> 'synthetic',getItems:async()=>history,addItems:async items=>{history.push(...items);},
  popItem:async()=>undefined,clearSession:async()=>{history.length=0;}};
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  sent.push(JSON.parse(String(init?.body)));const reply=replies[sent.length-1]!;
  return new Response(completion(sent.length,reply,reply.tool_calls?'tool_calls':'stop'));
 }});
 const turn=async(input:string)=>{
  let historyCount=0;
  return runRuntime({model:identity.model,instructions:sizing.instructions,input,session,maxTurns:2,maxOutputTokens:100,tools,
   selectHistory:async(old,incoming)=>{const selected=selectRuntimeHistory(old,incoming,sizing);historyCount=selected.length-incoming.length;return selected;},
   filterModelInput:items=>selectRuntimeCallInput(items,historyCount,sizing) as typeof items,
   reasoning:{effort:'low'},
   exchange:async(_sequence,body)=>{
    // Exactly the bytes a frozen v6 free-chat turn sends: projection, reasoning binding, routing.
    const request=openRouterRequestBody(body,{context,policy,phase:'ordinary',primaryDialogue:true});
    assertRuntimeRequestCapacity(request,sizing.inputBytes);
    return (await adapter.dispatch({input:request},policy)).rawBody;
   }});
 };
 return {history,sent,turn};
}
const toolCalls=(message:Record<string,unknown>)=>message.tool_calls as unknown[]|undefined;

it.each([null,'Let me check your sources.'])('Sonnet: a numbered tool call (content %s) continues with the source and replays on the next turn without the index', async content => {
 const c=conversation([{content,tool_calls:[{...sourceCall,index:0}]},{content:'Answer from source'},{content:'Next answer'}]);
 expect(await c.turn('Use my positioning')).toBe('Answer from source');
 expect(await c.turn('And next?')).toBe('Next answer');
 expect(c.sent).toHaveLength(3);
 for(const request of c.sent.slice(1)){
  const assistant=request.messages.find(message=>toolCalls(message)?.length)!;
  expect(toolCalls(assistant)).toEqual([sourceCall]);
  expect(request.messages.some(message=>message.role==='tool'&&message.tool_call_id===sourceCall.id)).toBe(true);
 }
 // The stored SDK items keep the provider's original metadata; only request bytes are projected.
 expect(JSON.stringify(c.history)).toContain('"index":0');
});

it('Gemini: signed completed text continues on the next turn and the signature is never forwarded', async () => {
 const c=conversation([{content:'First answer',reasoning_details:geminiSignature},{content:'Second answer',reasoning_details:geminiSignature}]);
 expect(await c.turn('Introduce yourself')).toBe('First answer');
 expect(await c.turn('Give me three titles')).toBe('Second answer');
 expect(JSON.stringify(c.sent[1])).not.toContain('SYNTHETIC_SIGNATURE');
 expect(c.sent[1]!.messages.filter(message=>message.role==='assistant')).toEqual([{role:'assistant',content:'First answer'}]);
});

it('Gemini: a signed tool call continues, but its signature is dropped by the SDK and never forwarded', async () => {
 // SDK 0.18 keeps no metadata for an empty-content tool-call reply, so the signature cannot be
 // replayed. Whether Gemini accepts the unsigned continuation is verified on staging, not here.
 const c=conversation([{content:null,tool_calls:[sourceCall],reasoning_details:geminiSignature},{content:'Answer from source'}]);
 expect(await c.turn('Use my positioning')).toBe('Answer from source');
 expect(JSON.stringify(c.sent[1])).not.toContain('SYNTHETIC_SIGNATURE');
});

it('still refuses a tool call index other than 0 before sending the continuation', async () => {
 const c=conversation([{content:null,tool_calls:[{...sourceCall,index:1}]},{content:'Must not be requested'}]);
 await expect(c.turn('Use my positioning')).rejects.toThrow();
 expect(c.sent).toHaveLength(1);
});
