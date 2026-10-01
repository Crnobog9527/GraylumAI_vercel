/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {ASK_QUESTION_ARGUMENT_LIMIT,toolArgumentLimit} from '../../shared/agentTurn';
import {toolCallFor,openRouterAdapter} from './openRouterAdapter';
import {openRouterBound} from './openRouterPolicy';
import {openRouterStream} from './openRouterStream';
import {AGENT_STREAM_TOOLS,AGENT_TOOL_NAMES} from '../runtime/agentTools';
import {normalizeOpenRouterHistory,projectOpenRouterItemsForSizing} from '../runtime/openRouterHistory';

const identity={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1',
 providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'},
 outputLimit:8192,upperUsd:'0.02'} as const;
const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'gen-capacity',model:identity.model,
 choices:[{index:0,delta,finish_reason}]})+'\n\n';
function wireFor(name:string,args:string){
 let wire=frame({role:'assistant'});
 // Argument fragments can arrive before the name; final classification is by the completed name.
 for(let index=0;index<args.length;index+=2048){
  wire+=frame({tool_calls:[{index:0,...(index===0?{id:'call-card',type:'function'}:{}),
   function:{arguments:args.slice(index,index+2048)}}]});
 }
 wire+=frame({tool_calls:[{index:0,function:{name}}]},'tool_calls');
 return wire+'data: '+JSON.stringify({id:'gen-capacity',model:identity.model,choices:[],
  usage:{prompt_tokens:1,completion_tokens:8192,total_tokens:8193,cost:0.007}})+'\n\ndata: [DONE]\n\n';
}

it.each(['ask_question','read_skill_file','read_source'])(
 'matches stream, request/history, SDK sizing and durable receipt limits for %s',async name=>{
 const names=name==='read_source'?new Set([name]):AGENT_TOOL_NAMES;
 const tools=name==='read_source'?{toolNames:names,maxCalls:1}:AGENT_STREAM_TOOLS;
 for(const extra of [0,1]){
  const args=JSON.stringify({message:'x'.repeat(toolArgumentLimit(name)-14+extra)});
  expect(args.length).toBe(toolArgumentLimit(name)+extra);
  const call={id:'call-card',type:'function',function:{name,arguments:args}};
  expect(toolCallFor(names).safeParse(call).success).toBe(extra===0);
  const history={messages:[{role:'assistant',content:[{type:'text',text:'',tool_calls:[call]}],tool_calls:[call]},
   {role:'tool',tool_call_id:'call-card',content:'{}'},{role:'user',content:'selected'}]};
  const items=[{type:'function_call',callId:'call-card',name,arguments:args},
   {type:'function_call_result',callId:'call-card',name,output:'{}'}];
  if(extra){
   expect(()=>normalizeOpenRouterHistory(history,names)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
   expect(()=>projectOpenRouterItemsForSizing(items,0,names)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
  }else{
   normalizeOpenRouterHistory(history,names);
   expect(history.messages[0]!.tool_calls![0]!.function.arguments).toBe(args);
   expect(projectOpenRouterItemsForSizing(items,0,names)[0]).toMatchObject({tool_calls:[call]});
  }
  const wire=wireFor(name,args);
  const parser=openRouterStream(identity.model,undefined,undefined,tools);
  parser.push(wire);
  expect(Boolean(parser.result().error)).toBe(extra===1);
  const adapter=openRouterAdapter({allowAgentTools:name!=='read_source',allowWorkspaceRead:name==='read_source',credential:async()=> 'SYNTHETIC_ONLY',
   transport:async()=>new Response(wire)});
  const input=JSON.stringify({model:identity.model,stream:true,stream_options:{include_usage:true},store:false,
   messages:[],...(name!=='read_source'?{tools:[{type:'function',function:{name,parameters:{type:'object'}}}]}:{}),
   max_tokens:8192,provider:openRouterBound(identity.providerLimits,8192).routing});
  const replayInput=JSON.stringify({...JSON.parse(input),messages:[
   {role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:'call-card',content:'{}'}]});
  if(extra)await expect(adapter.prepareDispatch({input:replayInput},identity)).rejects.toThrow('BILL2_PROVIDER_REQUEST_DENIED');
  else await expect(adapter.prepareDispatch({input:replayInput},identity)).resolves.toBeTypeOf('function');
  const observed=await adapter.dispatch({input},identity);
  const receipt=adapter.evidence(observed,identity,'response');
  if(extra){
   expect(receipt.final).toBe(false);
   expect(receipt.usage).toBeNull();
  }else{
   expect(receipt).toMatchObject({final:true,cost:'0.007',usage:{sdkResponse:{choices:[{message:{tool_calls:[call]}}]}}});
   // A new evidence projection replays the retained provider bytes without truncation.
   expect(adapter.evidence(JSON.parse(JSON.stringify(observed)),identity,'response')).toMatchObject({usage:receipt.usage});
  }
 }
 expect(toolArgumentLimit(name)).toBe(name==='ask_question'?ASK_QUESTION_ARGUMENT_LIMIT:4000);
});
