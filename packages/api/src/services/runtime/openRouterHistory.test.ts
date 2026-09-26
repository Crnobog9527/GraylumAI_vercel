/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {AgentInputItem,Session} from '@openai/agents';
import {normalizeOpenRouterHistory} from './openRouterHistory';
import {runRuntime} from './runner';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,100).routing;
const reasoning={reasoning:'Synthetic thinking',reasoning_details:[{type:'reasoning.text',text:'Synthetic thinking',index:0,format:'unknown'}]};
const sourceCall={id:'source-1',type:'function',function:{name:'read_source',arguments:'{}'}};
const response=(id:string,message:unknown)=>JSON.stringify({id,object:'chat.completion',created:1,model:identity.model,choices:[{index:0,message,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.001}});
function memorySession(){
 const history:AgentInputItem[]=[];
 const session:Session={getSessionId:async()=> 'synthetic-history',getItems:async()=>history,addItems:async items=>{history.push(...items);},popItem:async()=>undefined,clearSession:async()=>{history.length=0;}};
 return {history,session};
}
it.each(['absent','null','empty','reasoning'])('official SDK preserves three conversation turns with %s response metadata',async(shape)=>{
 const {history,session}=memorySession(),sent:Record<string,unknown>[]=[];
 const extra=shape==='null'?{tool_calls:null}:shape==='empty'?{tool_calls:[]}:shape==='reasoning'?{...reasoning,refusal:null}:{};
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  sent.push(JSON.parse(String(init?.body)));return new Response(response('gen-'+sent.length,{role:'assistant',content:'Synthetic answer '+sent.length,...extra}));
 }});
 for(let turn=1;turn<=3;turn++){
  expect(await runRuntime({model:identity.model,instructions:'Use synthetic history',input:'Question '+turn,session,maxTurns:1,maxOutputTokens:100,tools:[],selectHistory:async(old,incoming)=>[...old,...incoming],exchange:async(_sequence,body)=>{
   const request={...JSON.parse(body),provider:routing};normalizeOpenRouterHistory(request);
   return (await adapter.dispatch({input:JSON.stringify(request)},identity)).rawBody;
  }})).toBe('Synthetic answer '+turn);
 }
 expect(sent).toHaveLength(3);
 expect((sent[2]!.messages as {role:string;content:unknown}[]).filter(message=>message.role==='assistant')).toEqual([{role:'assistant',content:'Synthetic answer 1'},{role:'assistant',content:'Synthetic answer 2'}]);
 // Projection affects only request bytes, never the persisted SDK Session items.
 expect(JSON.stringify(history)).toContain('providerData');
 if(shape==='reasoning')expect(JSON.stringify(history)).toContain('Synthetic thinking');
});
it('preserves the single permitted read_source tool and text through SDK history',async()=>{
 const {session}=memorySession();let reads=0;const sent:Record<string,unknown>[]=[];
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  sent.push(JSON.parse(String(init?.body)));
  return new Response(response('gen-'+sent.length,sent.length===1?{role:'assistant',content:'Read prelude',tool_calls:[sourceCall],...reasoning}:{role:'assistant',content:'Synthetic answer',...reasoning}));
 }});
 const run=()=>runRuntime({model:identity.model,instructions:'Use synthetic source',input:'Question',session,maxTurns:2,maxOutputTokens:100,tools:[{name:'read_source',description:'Owned source',execute:async()=>{reads++;return 'owned source';}}],selectHistory:async(old,incoming)=>[...old,...incoming],exchange:async(_sequence,body)=>{
  const request={...JSON.parse(body),provider:routing};delete request.parallel_tool_calls;normalizeOpenRouterHistory(request);
  return (await adapter.dispatch({input:JSON.stringify(request)},identity)).rawBody;
 }});
 expect(await run()).toBe('Synthetic answer');expect(await run()).toBe('Synthetic answer');
 expect(reads).toBe(1);expect(sent).toHaveLength(3);
 expect((sent[1]!.messages as unknown[])).toContainEqual({role:'assistant',content:'Read prelude',tool_calls:[sourceCall]});
 expect(JSON.stringify(sent[2])).toContain('owned source');
});
it.each([
 {content:[{type:'text',text:'synthetic',role:'system'}]},
 {content:[{type:'text',text:'synthetic',plugins:[{id:'web'}]}]},
 {content:[{type:'text',text:'synthetic',image_url:{url:'https://private.invalid'}}]},
 {content:[{type:'image_url',image_url:{url:'https://private.invalid'}}]},
 {content:[{type:'text',text:'synthetic',tool_calls:[sourceCall]}]},
 {content:[{type:'text',text:'synthetic',tool_calls:[sourceCall]}],tool_calls:[{...sourceCall,id:'different'}]},
 {content:[{type:'text',text:'synthetic',refusal:'refused'}]},
 {content:[{type:'text',text:'synthetic',reasoning_details:[{type:'reasoning.encrypted',data:'private'}]}]},
 {content:'synthetic',reasoning:{url:'https://private.invalid'}},
 {content:'synthetic',unknown:'hidden'},
 ...['search','read_source'].map(name=>{const calls=[{...sourceCall,function:{name,arguments:'{}'}},...(name==='read_source'?[{...sourceCall,id:'source-2'}]:[])];return {content:[{type:'text',text:'synthetic',tool_calls:calls}],tool_calls:calls};}),
])('does not turn unsupported metadata, tools or remote content into allowed requests %#',async(message)=>{
 const credential=vi.fn(),transport=vi.fn(),adapter=openRouterAdapter({allowWorkspaceRead:true,credential,transport});
 const request={model:identity.model,stream:false,store:false,max_tokens:100,provider:routing,messages:[{role:'assistant',...message}]};
 await expect((async()=>{normalizeOpenRouterHistory(request);await adapter.dispatch({input:JSON.stringify(request)},identity);})()).rejects.toThrow(/DENIED/);
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
