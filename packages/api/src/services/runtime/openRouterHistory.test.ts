/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {AgentInputItem,Session} from '@openai/agents';
import {normalizeOpenRouterHistory,projectOpenRouterItemsForSizing} from './openRouterHistory';
import {runRuntime} from './runner';
import {AGENT_TOOL_NAMES} from './agentTools';
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

// Synthetic opaque data only. No real provider reasoning is needed or decoded.
const encryptedDetail={type:'reasoning.encrypted',format:'openai-responses-v1',id:'rs_synthetic',data:'SYNTHETIC_OPAQUE'.repeat(800),index:0};
const summaryDetail={type:'reasoning.summary',format:'openai-responses-v1',summary:'Synthetic private summary',index:0};
it.each([[encryptedDetail],[{...encryptedDetail,id:null,index:undefined}],[summaryDetail],
 [{...summaryDetail,id:null,index:undefined}],[{...summaryDetail,id:'rs_summary'}],
 [summaryDetail,{...encryptedDetail,index:1}],
].map(details=>({details})))('projects known OpenAI reasoning to text without mutating stored history %#',({details})=>{
 const metadata={role:'assistant',refusal:null,reasoning:null,reasoning_details:details};
 const item={type:'message',role:'assistant',content:[{type:'output_text',text:'Organizer result',providerData:metadata}]};
 const history=[{role:'user',content:'First input'},item],incoming=[{role:'user',content:'Next mentor input'}],before=JSON.stringify(history);
 for(const selected of [selectRuntimeHistory(history,incoming,sizing),selectRuntimeCallInput([...history,...incoming],history.length,sizing)]){
  expect(selected).toHaveLength(3);expect(selected[1]).toBe(item);
 }
 expect(projectOpenRouterItemsForSizing(history)).toEqual([{role:'user',content:'First input'},{role:'assistant',content:'Organizer result'}]);
 const request={messages:[{role:'assistant',content:[{type:'text',text:'Organizer result',...metadata}]}]};
 normalizeOpenRouterHistory(request);expect(request.messages).toEqual([{role:'assistant',content:'Organizer result'}]);
 const topLevel={messages:[{content:'Organizer result',...metadata}]};
 normalizeOpenRouterHistory(topLevel);expect(topLevel.messages).toEqual([{role:'assistant',content:'Organizer result',refusal:null}]);
 expect(JSON.stringify(history)).toBe(before);
});
it.each([
 {...encryptedDetail,format:'anthropic-claude-v1'},
 {...encryptedDetail,type:'reasoning.unknown'},
 {...encryptedDetail,data:null},
 {...encryptedDetail,data:''},
 {...encryptedDetail,data:{url:'https://private.invalid'}},
 {...encryptedDetail,id:23},
 {...encryptedDetail,index:-1},
 {...encryptedDetail,index:0.5},
 {...encryptedDetail,extra:'hidden'},
 {...encryptedDetail,data:'x'.repeat(139265)},
])('rejects malformed opaque reasoning before sizing cuts or credential access %#',async(detail)=>{
 const metadata={role:'assistant',reasoning_details:[detail]};
 const item={type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic answer',providerData:metadata}]},incoming=[{role:'user',content:'Next'}];
 expect(()=>selectRuntimeHistory([item],incoming,{...sizing,historyItems:0})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([item,...incoming],1,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([...incoming,item],0,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 const credential=vi.fn(),transport=vi.fn(),adapter=openRouterAdapter({credential,transport});
 for(const message of [{content:'Synthetic answer',...metadata},{role:'assistant',content:[{type:'text',text:'Synthetic answer',...metadata}]}]){
  const request={model:identity.model,stream:false,store:false,max_tokens:100,provider:routing,messages:[message]};
  await expect((async()=>{normalizeOpenRouterHistory(request);await adapter.dispatch({input:JSON.stringify(request)},identity);})()).rejects.toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 }
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
it.each([[encryptedDetail],[summaryDetail],[summaryDetail,{...encryptedDetail,index:1}]].map(details=>({details})))('does not extend OpenAI reasoning support to a tool continuation %#',async({details})=>{
 const metadata={reasoning_details:details,tool_calls:[sourceCall]};
 const item={type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic prelude',providerData:{role:'assistant',...metadata}}]};
 expect(()=>projectOpenRouterItemsForSizing([item,{type:'function_call',callId:sourceCall.id,name:'read_source',arguments:'{}'},{type:'function_call_result',callId:sourceCall.id,name:'read_source',output:'source'}])).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 const credential=vi.fn(),transport=vi.fn(),adapter=openRouterAdapter({allowWorkspaceRead:true,credential,transport});
 for(const message of [{role:'assistant',content:'Synthetic prelude',...metadata},{role:'assistant',content:[{type:'text',text:'Synthetic prelude',reasoning_details:details}],tool_calls:[sourceCall]}]){
  const request={model:identity.model,stream:false,store:false,max_tokens:100,provider:routing,messages:[message]};
  await expect((async()=>{normalizeOpenRouterHistory(request);await adapter.dispatch({input:JSON.stringify(request)},identity);})()).rejects.toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 }
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});

it.each([
 {...summaryDetail,type:'reasoning.unknown'},
 {...summaryDetail,format:'unknown'},
 {...summaryDetail,format:'anthropic-claude-v1'},
 {...summaryDetail,summary:undefined},
 {...summaryDetail,summary:null},
 {...summaryDetail,summary:23},
 {...summaryDetail,summary:{text:'hidden'}},
 {...summaryDetail,summary:'x'.repeat(139265)},
 {...summaryDetail,id:23},
 {...summaryDetail,id:''},
 {...summaryDetail,id:'x'.repeat(257)},
 {...summaryDetail,index:-1},
 {...summaryDetail,index:0.5},
 {...summaryDetail,index:null},
 {...summaryDetail,extra:'hidden'},
])('rejects malformed summaries before sizing cuts and wire dispatch %#',async(detail)=>{
 const metadata={role:'assistant',reasoning_details:[detail]};
 const item={type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic answer',providerData:metadata}]},incoming=[{role:'user',content:'Next'}];
 expect(()=>selectRuntimeHistory([item],incoming,{...sizing,historyItems:0})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>selectRuntimeCallInput([item,...incoming],1,sizing)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 const credential=vi.fn(),transport=vi.fn(),adapter=openRouterAdapter({credential,transport});
 for(const message of [{content:'Synthetic answer',...metadata},{role:'assistant',content:[{type:'text',text:'Synthetic answer',...metadata}]}]){
  const request={model:identity.model,stream:false,store:false,max_tokens:100,provider:routing,messages:[message]};
  await expect((async()=>{normalizeOpenRouterHistory(request);await adapter.dispatch({input:JSON.stringify(request)},identity);})()).rejects.toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 }
 expect(credential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});

it('does not accept summary metadata from user content or hide unknown metadata beside a valid summary',()=>{
 for(const metadata of [{reasoning_details:[summaryDetail]}, {reasoning_details:[summaryDetail,{type:'reasoning.unknown'}]}]){
  const item={role:'user',content:[{type:'input_text',text:'Synthetic input',providerData:metadata}]};
  expect(()=>projectOpenRouterItemsForSizing([item])).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 }
 expect(()=>normalizeOpenRouterHistory({messages:[{role:'assistant',content:'answer',reasoning_details:[summaryDetail,{type:'reasoning.unknown'}]}]})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});

it('locked SDK continues alternating Qwen/Luna turns with summary plus encrypted history without mutating stored items',async()=>{
 const {history,session}=memorySession(),sent:Record<string,unknown>[]=[];
 const models=['synthetic/qwen','synthetic/luna','synthetic/qwen','synthetic/luna','synthetic/qwen'];
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  const request=JSON.parse(String(init?.body));sent.push(request);
  const details=request.model==='synthetic/luna'?[summaryDetail,{...encryptedDetail,index:1}]:reasoning.reasoning_details;
  return new Response(response('gen-'+sent.length,{role:'assistant',content:'Answer '+sent.length,reasoning_details:details}));
 }});
 for(const model of models){
  let historyCount=0;
  const before=JSON.stringify(history),oldLength=history.length;
  expect(await runRuntime({model,instructions:sizing.instructions,input:'Next synthetic turn',session,maxTurns:1,maxOutputTokens:100,tools:[],
   selectHistory:async(old,incoming)=>{const selected=selectRuntimeHistory(old,incoming,sizing);historyCount=selected.length-incoming.length;return selected;},
   filterModelInput:items=>selectRuntimeCallInput(items,historyCount,sizing) as typeof items,
   exchange:async(_sequence,body)=>{
    const request={...JSON.parse(body),provider:routing};normalizeOpenRouterHistory(request);assertRuntimeRequestCapacity(JSON.stringify(request),sizing.inputBytes);
    return (await adapter.dispatch({input:JSON.stringify(request)},{...identity,model})).rawBody;
   },
  })).toBe('Answer '+sent.length);
  expect(JSON.stringify(history.slice(0,oldLength))).toBe(before);
 }
 expect(sent.map(request=>request.model)).toEqual(models);
 expect(JSON.stringify(history)).toContain('reasoning.summary');
 expect(JSON.stringify(history)).toContain('reasoning.encrypted');
 expect(JSON.stringify(sent)).not.toContain('Synthetic private summary');
 expect(JSON.stringify(sent)).not.toContain('SYNTHETIC_OPAQUE');
 expect((sent[4]!.messages as {role:string;content:unknown}[]).filter(message=>message.role==='assistant')).toEqual([1,2,3,4].map(turn=>({role:'assistant',content:'Answer '+turn})));
});

it.each([null,{},['citation'],[{type:'url_citation',url:'https://private.invalid'}]])('rejects non-empty or malformed streaming annotations in sizing and wire %#',annotations=>{
 const item={role:'assistant',content:[{type:'output_text',text:'Public answer',providerData:{annotations}}]};
 expect(()=>projectOpenRouterItemsForSizing([item])).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>normalizeOpenRouterHistory({messages:[{role:'assistant',content:[{type:'text',text:'Public answer',annotations}]}]})).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
it('does not accept even empty assistant annotations on user content',()=>{
 expect(()=>projectOpenRouterItemsForSizing([{role:'user',content:[{type:'input_text',text:'Input',providerData:{annotations:[]}}]}])).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
it('locked SDK streaming history with empty annotations continues through Luna and the next mentor without rewriting stored items',async()=>{
 const {history,session}=memorySession(),sent:Record<string,unknown>[]=[];
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_ONLY',transport:async(_url,init)=>{
  const request=JSON.parse(String(init?.body));sent.push(request);const id='gen-stream-history-'+sent.length;
  if(!request.stream)return new Response(response(id,{role:'assistant',content:'Answer '+sent.length,reasoning_details:[summaryDetail,{...encryptedDetail,index:1}]}));
  const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
  return new Response(frame({role:'assistant',reasoning:'PRIVATE_STREAM_REASONING'})+frame({content:'Answer '})+frame({content:String(sent.length)},'stop')+
   'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.001}})+'\n\ndata: [DONE]\n\n');
 }});
 for(const stream of [true,false,true]){
  let historyCount=0;const before=JSON.stringify(history),oldLength=history.length;
  const result=await runRuntime({model:identity.model,stream,instructions:sizing.instructions,input:'Next turn',session,maxTurns:1,maxOutputTokens:100,tools:[],
   selectHistory:async(old,incoming)=>{const selected=selectRuntimeHistory(old,incoming,sizing);historyCount=selected.length-incoming.length;return selected;},
   filterModelInput:items=>selectRuntimeCallInput(items,historyCount,sizing) as typeof items,
   exchange:async(_sequence,body,onChunk)=>{
    const request={...JSON.parse(body),provider:routing};normalizeOpenRouterHistory(request);
    const send=await adapter.prepareDispatch({input:JSON.stringify(request)},identity,onChunk);
    const observed=await send();return adapter.evidence(observed,identity,'response').rawBody;
   },
  });
  expect(result).toBe('Answer '+sent.length);expect(JSON.stringify(history.slice(0,oldLength))).toBe(before);
 }
 expect(sent).toHaveLength(3);expect(JSON.stringify(history)).toContain('"annotations":[]');
 expect(JSON.stringify(history)).toContain('reasoning.summary');expect(JSON.stringify(history)).toContain('reasoning.encrypted');
 expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_STREAM_REASONING|Synthetic private summary|SYNTHETIC_OPAQUE|annotations/);
 expect((sent[2]!.messages as {role:string;content:unknown}[]).filter(item=>item.role==='assistant')).toEqual([{role:'assistant',content:'Answer 1'},{role:'assistant',content:'Answer 2'}]);
});

// AC-1: question card rounds in history, accepted only with the Agent turn allowlist.
const askCall={id:'ask-1',type:'function',function:{name:'ask_question',arguments:'{"question":"q","options":["a","b"]}'}};
const askHistory=()=>[
 {type:'message',role:'user',content:'hello'},
 {id:'m1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'先问一下',providerData:{role:'assistant',tool_calls:[askCall]}}]},
 {type:'function_call',callId:'ask-1',name:'ask_question',arguments:askCall.function.arguments,status:'completed',providerData:{type:'function',function:askCall.function}},
 {type:'function_call_result',callId:'ask-1',name:'ask_question',status:'completed',output:{type:'text',text:'{"card":"question"}'}},
 {type:'message',role:'user',content:'a'},
];
it('replays a question card round only under the Agent turn allowlist',()=>{
 expect(()=>projectOpenRouterItemsForSizing(askHistory())).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(projectOpenRouterItemsForSizing(askHistory(),0,AGENT_TOOL_NAMES).map(item=>(item as {role?:string}).role)).toEqual(['user','assistant','assistant','tool','user']);
 const request={messages:[{role:'assistant',content:[{type:'text',text:'先问一下',role:'assistant',tool_calls:[askCall]}],tool_calls:[askCall]}]};
 expect(()=>normalizeOpenRouterHistory(structuredClone(request))).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 const normalized=structuredClone(request);normalizeOpenRouterHistory(normalized,AGENT_TOOL_NAMES);
 expect(normalized.messages[0]).toEqual({role:'assistant',content:'先问一下',tool_calls:[askCall]});
});
it('rejects a tool result whose name differs from its call',()=>{
 const items=askHistory();(items[3] as {name:string}).name='read_skill_file';
 expect(()=>projectOpenRouterItemsForSizing(items,0,AGENT_TOOL_NAMES)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});

it('projects observed signed Anthropic text metadata without forwarding private reasoning or signatures',()=>{
 const detail={type:'reasoning.text',format:'anthropic-claude-v1',index:0,text:'SYNTHETIC_PRIVATE',signature:'SYNTHETIC_SIGNATURE'};
 const item={type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Public answer',
  providerData:{role:'assistant',refusal:null,reasoning:'SYNTHETIC_PRIVATE',reasoning_details:[detail]}}]};
 expect(projectOpenRouterItemsForSizing([item])).toEqual([{role:'assistant',content:'Public answer'}]);
 const request={messages:[{role:'assistant',content:[{type:'text',text:'Public answer',reasoning_details:[detail]}]}]};
 normalizeOpenRouterHistory(request);
 expect(request.messages).toEqual([{role:'assistant',content:'Public answer'}]);
 expect(item.content[0]!.providerData.reasoning_details).toEqual([detail]);
});

it.each([
 {format:'anthropic-claude-v1',signature:null},
 {format:'anthropic-claude-v1',signature:''},
 {format:'anthropic-claude-v1',signature:'ok',unknown:true},
 {format:'unknown',signature:'ok'},
 {format:'future-provider',signature:'ok'},
])('still denies malformed or unknown signed metadata %j',extra=>{
 const details=[{type:'reasoning.text',index:0,text:'Synthetic',...extra}];
 expect(()=>normalizeOpenRouterHistory({messages:[{role:'assistant',content:'Answer',reasoning_details:details}]}))
  .toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
it('denies signed tool continuations even when the duplicated call matches',()=>{
 const details=[{type:'reasoning.text',format:'anthropic-claude-v1',index:0,text:'Synthetic',signature:'Signature'}];
 expect(()=>normalizeOpenRouterHistory({messages:[{role:'assistant',content:'Answer',reasoning_details:details,tool_calls:[sourceCall]}]}))
  .toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
