/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {AgentInputItem,Session} from '@openai/agents';
import {normalizeOpenRouterHistory,projectOpenRouterItemsForSizing} from './openRouterHistory';
import {runRuntime} from './runner';
import {selectRuntimeHistory,selectRuntimeCallInput,assertRuntimeRequestCapacity} from './context';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},outputLimit:100,upperUsd:'0.02'} as const;
const routing=openRouterBound(identity.providerLimits,100).routing;
const thinking='Synthetic thinking '.repeat(800);
const reasoning={reasoning:thinking,reasoning_details:[{type:'reasoning.text',text:thinking,index:0,format:'unknown'}]};
const sizing={instructions:'Use synthetic history',inputBytes:5000,historyItems:30,toolBytes:300,projectItemsForSizing:projectOpenRouterItemsForSizing};
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
  let historyCount=0;
  expect(await runRuntime({model:identity.model,instructions:'Use synthetic history',input:'Question '+turn,session,maxTurns:1,maxOutputTokens:100,tools:[],selectHistory:async(old,incoming)=>{const selected=selectRuntimeHistory(old,incoming,sizing);historyCount=selected.length-incoming.length;return selected;},filterModelInput:items=>selectRuntimeCallInput(items,historyCount,sizing) as typeof items,exchange:async(_sequence,body)=>{
   const request={...JSON.parse(body),provider:routing};normalizeOpenRouterHistory(request);assertRuntimeRequestCapacity(JSON.stringify(request),sizing.inputBytes);
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
 const {session}=memorySession();let reads=0,historyCount=0;const sent:Record<string,unknown>[]=[];
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  sent.push(JSON.parse(String(init?.body)));
  return new Response(response('gen-'+sent.length,sent.length===1?{role:'assistant',content:'Read prelude',tool_calls:[sourceCall],...reasoning}:{role:'assistant',content:'Synthetic answer',...reasoning}));
 }});
 const run=()=>runRuntime({model:identity.model,instructions:'Use synthetic source',input:'Question',session,maxTurns:2,maxOutputTokens:100,tools:[{name:'read_source',description:'Owned source',execute:async()=>{reads++;return 'owned source';}}],selectHistory:async(old,incoming)=>{const selected=selectRuntimeHistory(old,incoming,sizing);historyCount=selected.length-incoming.length;return selected;},filterModelInput:items=>selectRuntimeCallInput(items,historyCount,sizing) as typeof items,exchange:async(_sequence,body)=>{
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

const sdkHistory=()=>[
 {role:'user',content:'Old question'},
 {type:'reasoning',content:[],rawContent:[{type:'reasoning_text',text:thinking}]},
 {id:'synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Useful old answer',providerData:{role:'assistant',refusal:null,...reasoning}}]},
];
it('sizes both cuts by v2 text while preserving original Session references and legacy sizing',()=>{
 const history=sdkHistory(),incoming=[{role:'user',content:'Follow-up'}],before=JSON.stringify(history);
 expect(Buffer.byteLength(before)).toBeGreaterThan(sizing.inputBytes*8);
 for(const selected of [selectRuntimeHistory(history,incoming,sizing),selectRuntimeCallInput([...history,...incoming],history.length,sizing)]){
  expect(selected).toHaveLength(4);selected.slice(0,3).forEach((item,index)=>expect(item).toBe(history[index]));
 }
 expect(JSON.stringify(history)).toBe(before);
 const {projectItemsForSizing:_,...legacy}=sizing;
 expect(selectRuntimeHistory(history,incoming,legacy)).toEqual(incoming);
 expect(selectRuntimeCallInput([...history,...incoming],history.length,legacy)).toEqual(incoming);
 // The real text and final wire body retain their capacity checks.
 const oversized=[{role:'user',content:'x'.repeat(6000)}];
 expect(()=>selectRuntimeHistory([],oversized,sizing)).toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 expect(()=>selectRuntimeCallInput(oversized,0,sizing)).toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 expect(()=>assertRuntimeRequestCapacity(JSON.stringify({messages:oversized}),5000)).toThrow('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
});
it.each([
 {role:'assistant',content:[{type:'output_text',text:'x',providerData:{...reasoning,plugins:[{id:'web'}]}}]},
 {role:'assistant',content:[{type:'output_text',text:'x',providerData:{...reasoning,role:'system'}}]},
 {role:'assistant',content:[{type:'output_text',text:'x',providerData:{...reasoning,text:'hidden'}}]},
 {role:'user',content:[{type:'input_image',image:'https://private.invalid'}]},
 {role:'assistant',content:[{type:'output_text',text:'x',providerData:{...reasoning,tool_calls:[{...sourceCall,function:{name:'search',arguments:'{}'}}]}}]},
 {role:'assistant',content:[{type:'output_text',text:'x',providerData:{...reasoning,tool_calls:[sourceCall,{...sourceCall,id:'second'}]}}]},
 {type:'function_call',callId:'unknown',name:'search',arguments:'{}'},
])('rejects unsupported items before either cut, even outside historyItems %#',item=>{
 const incoming=[{role:'user',content:'New question'}];
 expect(()=>selectRuntimeHistory([item],incoming,{...sizing,historyItems:0})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([item,...incoming],1,{...sizing,inputBytes:1000})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([...incoming,item],0,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
it('rejects parallel SDK function calls before historical trimming',()=>{
 const call={type:'function_call',callId:'one',name:'read_source',arguments:'{}'},result={type:'function_call_result',callId:'one',name:'read_source',output:{type:'text',text:'source'}};
 const parallel=[call,{...call,callId:'two'},result,{...result,callId:'two'}],incoming=[{role:'user',content:'New question'}];
 expect(()=>selectRuntimeHistory(parallel,incoming,{...sizing,historyItems:0})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([...parallel,...incoming],parallel.length,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});

it('keeps required reasoning and one tool trace using only their normalized wire contents for sizing',()=>{
 const call={type:'function_call',callId:'source',name:'read_source',arguments:JSON.stringify({query:'q'.repeat(1800)}),providerData:{type:'function',function:{name:'read_source',arguments:JSON.stringify({query:'q'.repeat(1800)})}}};
 const result={type:'function_call_result',callId:'source',name:'read_source',output:{type:'text',text:'Owned source'}};
 const required=[...sdkHistory(),call,result],before=JSON.stringify(required),limit={...sizing,inputBytes:3000};
 const selected=selectRuntimeCallInput(required,0,limit);
 expect(selected).toHaveLength(required.length);selected.forEach((item,index)=>expect(item).toBe(required[index]));
 expect(Buffer.byteLength(JSON.stringify(projectOpenRouterItemsForSizing(required)))).toBeLessThan(2500);
 expect(JSON.stringify(required)).toBe(before);
 expect(()=>selectRuntimeCallInput([...required,{role:'user',content:'x'.repeat(4000)}],0,limit)).toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
});

it('keeps the existing safe discard for a SQL history window starting at a tool result',()=>{
 const result={type:'function_call_result',callId:'truncated-call',name:'read_source',output:{type:'text',text:'Old source'}};
 const history=[result,...sdkHistory()],incoming=[{role:'user',content:'New question'}];
 expect(selectRuntimeHistory(history,incoming,sizing)).toEqual(incoming);
 // Even when normalized history fits, never send an orphan to the model.
 for(const inputBytes of [5000,700])expect(selectRuntimeCallInput([...history,...incoming],history.length,{...sizing,inputBytes})).toEqual(incoming);
 expect(()=>selectRuntimeCallInput([result,...incoming],0,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 const unsupported={...result,providerData:{plugins:[{id:'web'}]}};
 expect(()=>selectRuntimeHistory([unsupported],incoming,{...sizing,historyItems:0})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([unsupported,...incoming],1,{...sizing,inputBytes:200})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
