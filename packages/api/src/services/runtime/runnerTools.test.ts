/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {AgentInputItem,Session} from '@openai/agents';
import {askQuestionTool,askQuestionToolBytes,INVALID_CARD_RESULT,questionCardFromResult} from './agentTools';
import {runRuntime,type RuntimeTool} from './runner';
import {openRouterRequestBody} from './providerRequest';

const session=():Session=>({getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},popItem:async()=>undefined,clearSession:async()=>{}});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const completion=(message:Record<string,unknown>,finish='stop')=>({id:'local',object:'chat.completion',created:1,model:'m/x',choices:[{index:0,message:{role:'assistant',...message},finish_reason:finish}]});
const sourceCall={id:'call_source_1',type:'function',function:{name:'read_source',arguments:'{}'}};

/** Old-format request bytes with the only existing tool: a read, then an answer. */
async function legacyToolBodies(stream:boolean,reasoning?:{effort:'none'}){
 const bodies:string[]=[];
 const responses=[completion({content:null,tool_calls:[sourceCall]},'tool_calls'),completion({content:'ok'})];
 const exchange=vi.fn(async(_sequence:number,request:string,onChunk?:(chunk:string)=>void)=>{
  bodies.push(request);const response=responses[bodies.length-1]!;
  onChunk?.(JSON.stringify({...response,object:'chat.completion.chunk',choices:[{index:0,delta:response.choices[0]!.message,finish_reason:response.choices[0]!.finish_reason}]}));
  return JSON.stringify(response);
 });
 const tools:RuntimeTool[]=[{name:'read_source',description:'Read the selected source only.',execute:async()=>JSON.stringify({body:'SOURCE'})}];
 const output=await runRuntime({model:'m/x',instructions:'系统说明',input:'hello',session:session(),maxOutputTokens:4096,maxTurns:2,tools,selectHistory:async(_h,i)=>i,exchange,stream,...(reasoning?{reasoning}:{})});
 expect(output).toBe('ok');expect(exchange).toHaveBeenCalledTimes(2);
 return bodies;
}

it.each([
 ['serial-tools-v2 (non-streaming)',false,undefined],
 ['serial-tools-v3-stream',true,undefined],
 ['serial-tools-v4-stream',true,{effort:'none' as const}],
])('keeps %s SDK request bytes with the read_source tool unchanged',async(_format,stream,reasoning)=>{
 const bodies=await legacyToolBodies(stream,reasoning);
 expect(bodies.map(sha)).toEqual(GOLDEN[`${stream}:${reasoning?.effort??''}`]);
});

// Recorded by the locked SDK on the AC1-2 base before AC1-3 changed runner.ts.
const GOLDEN:Record<string,string[]>={
 'false:':['9c9feac9184d627bb0b37ba8f9edec048295c5c2452deb9ea27fda61efd99208','b5fcbf0f19b242d08cc1f2e40e494cc58db0275c4b2cd09572e0310982299525'],
 'true:':['d3dd9ff8bf9697e21e86b27f55863b82f0c753ba7afab2b7e301f1d910ab2016','962196fc6db1e37b7f109881d85c66f6f8175d5b40a8c3c70e9780c41500e56b'],
 'true:none':['5a87f930683951fbe9aae99819b001769ea3c00baa1dd63995b662ab0a21822e','960ee071168850b6fdd88ca3f098a4499ded99e6ea49b6793222548b85afd5a5'],
};

// ---------------------------------------------------------------------------
// Agent turn format (AC-1): used by new mentor admissions.
// ---------------------------------------------------------------------------

const card={question:'你主要在哪个平台？',options:['小红书','抖音'],recommended:null};
const askCall=(id:string,args:unknown=card)=>({id,type:'function',function:{name:'ask_question',arguments:JSON.stringify(args)}});
const frames=(response:ReturnType<typeof completion>)=>{
 const message=response.choices[0]!.message as {content?:string|null;tool_calls?:Array<{id:string;type:string;function:{name:string;arguments:string}}>};
 return [
  {...response,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:message.content??''},finish_reason:null}]},
  ...(message.tool_calls??[]).map((call,index)=>({...response,object:'chat.completion.chunk',choices:[{index:0,delta:{tool_calls:[{index,...call}]},finish_reason:null}]})),
  {...response,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:response.choices[0]!.finish_reason}]},
 ].map(frame=>JSON.stringify(frame));
};
type Mode='non-stream'|'stream'|'replay';
async function agentTurn(mode:Mode,response:ReturnType<typeof completion>,options:{firstToolCallOnly?:boolean;allowEmptyResult?:boolean;commitSessionOnSuccess?:boolean}={firstToolCallOnly:true}){
 const bodies:string[]=[],added:AgentInputItem[]=[],shown:string[]=[],dropped:number[]=[];
 const executed=vi.fn(askQuestionTool().execute);
 const exchange=vi.fn(async(_sequence:number,request:string,onChunk?:(chunk:string)=>void)=>{
  bodies.push(request);if(mode==='stream')for(const frame of frames(response))onChunk!(frame);
  return JSON.stringify(response);
 });
 const store:Session={...session(),addItems:async items=>{added.push(...items);}};
 const run=runRuntime({model:'m/x',instructions:'I',input:'hello',session:store,maxOutputTokens:4096,maxTurns:1,exchange,
  tools:[{...askQuestionTool(),execute:executed}],selectHistory:async(_h,i)=>i,stream:mode!=='non-stream',reasoning:{effort:'none'},
  stopAtToolNames:['ask_question'],...options,onToolCallsDropped:count=>dropped.push(count),onText:text=>shown.push(text)});
 return {run,bodies,added,shown,dropped,executed,exchange};
}
const modes:Mode[]=['non-stream','stream','replay'];

describe('Agent turn format',()=>{
 it('sends per-tool parameters and neither parallel_tool_calls nor tool_choice',async()=>{
  const t=await agentTurn('stream',completion({content:'好的'}));await t.run;
  const sent=JSON.parse(t.bodies[0]!);
  expect(sent).not.toHaveProperty('parallel_tool_calls');expect(sent).not.toHaveProperty('tool_choice');
  expect(sent.tools[0].function.name).toBe('ask_question');
  expect(Object.keys(sent.tools[0].function.parameters.properties)).toEqual(['question','options','recommended']);
 });

 it.each(modes)('ends the turn at the question card (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:'先了解一下。',tool_calls:[askCall('call_a')]},'tool_calls'));
  const output=await t.run;expect(JSON.parse(output)).toEqual({card:'question',...card});expect(questionCardFromResult(output)).toEqual(card);
  expect(t.exchange).toHaveBeenCalledTimes(1);expect(t.executed).toHaveBeenCalledTimes(1);expect(t.dropped).toEqual([]);
  if(mode!=='non-stream')expect(t.shown.join('')).toBe('先了解一下。');
  // The SDK stores the call and its result, so history replays the card as a tool round.
  expect(t.added.map(item=>'type' in item?item.type:undefined)).toEqual(expect.arrayContaining(['function_call','function_call_result']));
 });

 it.each(modes)('keeps only the first of several calls (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:'先了解一下。',tool_calls:[askCall('call_a'),askCall('call_b',{question:'另一个',options:['x','y'],recommended:0})]},'tool_calls'));
  expect(JSON.parse(await t.run)).toEqual({card:'question',...card});
  expect(t.executed).toHaveBeenCalledTimes(1);expect(t.exchange).toHaveBeenCalledTimes(1);expect(t.dropped).toEqual([1]);
  expect(JSON.stringify(t.added)).not.toContain('call_b');
 });

 it.each(modes)('an older format still rejects several calls (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:null,tool_calls:[askCall('call_a'),askCall('call_b')]},'tool_calls'),{firstToolCallOnly:false});
  await expect(t.run).rejects.toThrow('RUNTIME_EXECUTION_PENDING');expect(t.executed).not.toHaveBeenCalled();
 });

 it.each(modes)('never runs a tool call cut off by the output limit (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:'先了解',tool_calls:[askCall('call_a')]},'length'));
  await expect(t.run).rejects.toThrow('RUNTIME_OUTPUT_TRUNCATED');
  expect(t.executed).not.toHaveBeenCalled();expect(t.exchange).toHaveBeenCalledTimes(1);
 });

 it.each(modes)('stops an empty length-limited reply as truncated (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:null},'length'));
  await expect(t.run).rejects.toThrow('RUNTIME_OUTPUT_TRUNCATED');expect(t.exchange).toHaveBeenCalledTimes(1);
 });

 it.each(modes)('keeps a length-limited reply that has text and no tool call (%s)',async mode=>{
  const t=await agentTurn(mode,completion({content:'很长的回答'},'length'));
  expect(await t.run).toBe('很长的回答');
 });
});

describe('question card tool definition and invalid cards',()=>{
 it('sends a strict JSON Schema without the host-only card rules',async()=>{
  const t=await agentTurn('stream',completion({content:'好的'}));await t.run;
  expect(JSON.parse(t.bodies[0]!).tools).toEqual([{type:'function',function:{name:'ask_question',
   description:'Show the user one question card with 2 to 5 short suggested answers. recommended is the index of the option you '+
    'recommend, or null for neutral ranges or categories. The host adds an Other entry. Ends your turn.',strict:true,parameters:{
    $schema:'http://json-schema.org/draft-07/schema#',type:'object',additionalProperties:false,required:['question','options','recommended'],properties:{
     question:{type:'string',minLength:1,maxLength:500},
     options:{type:'array',minItems:2,maxItems:5,items:{type:'string',minLength:1,maxLength:200}},
     recommended:{anyOf:[{type:'number'},{type:'null'}]},
    }}}}]);
 });

 it.each([
  ['one option',{question:'问题',options:['只有一个'],recommended:null}],
  ['a missing question',{options:['小红书','抖音'],recommended:null}],
  ['a missing recommended field',{question:'问题',options:['小红书','抖音']}],
  ['a recommended index past the options',{...card,recommended:2}],
  ['a fractional recommended index',{...card,recommended:0.5}],
  ['a negative recommended index',{...card,recommended:-1}],
  ['duplicate options',{question:'问题',options:['小红书',' 小红书 '],recommended:null}],
  ['a control character',{question:'问\u0007题',options:['a','b'],recommended:null}],
  ['an extra field',{...card,allowFreeText:true}],
  ['arguments that are not JSON','{"question":'],
 ])('ends the turn without a card for %s, keeping the paid text (stream)',async(_name,args)=>{
  const call={id:'call_bad',type:'function',function:{name:'ask_question',arguments:typeof args==='string'?args:JSON.stringify(args)}};
  const t=await agentTurn('stream',completion({content:'先了解一下。',tool_calls:[call]},'tool_calls'));
  const output=await t.run;
  expect(questionCardFromResult(output)).toBeNull();if(typeof args!=='string')expect(output).toBe(INVALID_CARD_RESULT);
  expect(t.shown.join('')).toBe('先了解一下。');expect(t.exchange).toHaveBeenCalledTimes(1);expect(t.executed.mock.results.length).toBeLessThanOrEqual(1);
 });
});

it.each(modes)('an invalid card with no text at all is detectable, so AC1-4 can show a fixed notice (%s)',async mode=>{
 // AC-0 never saw this (65/65 calls wrote text first); the host must still not show a blank reply.
 const t=await agentTurn(mode,completion({content:null,tool_calls:[askCall('call_bad',{question:'问题',options:['只有一个']})]},'tool_calls'));
 const output=await t.run;
 expect(questionCardFromResult(output)).toBeNull();expect(t.shown.join('')).toBe('');expect(t.exchange).toHaveBeenCalledTimes(1);
});

it('freezes exact v5 provider request bytes including the exported strict tool schema',async()=>{
 const t=await agentTurn('stream',completion({content:'自然语言'}));await t.run;
 const context={providerRequestFormat:'agent-turn-v5-stream' as const,tools:['ask_question'],
  network:'deny',reasoning:{effort:'none' as const}};
 const policy={modelId:'10000000-0000-4000-8000-000000000001',provider:'openrouter',account:'synthetic',
  model:'m/x',protocol:'openrouter-chat-v1' as const,upperUsd:'0.0036096',inputLimit:32000,outputLimit:4096,
  automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true,
  providerLimits:{providerSlug:'deepinfra/fp8',contextTokens:32000,
   promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'}};
 const wire=openRouterRequestBody(t.bodies[0]!,{context,policy,phase:'skill',primaryDialogue:true});
 expect(sha(wire)).toBe('50d1722ae999281dee6566f1c10ae78463a90f772738cd2416505c7f2224ae49');
 const sent=JSON.parse(wire);
 expect(sent.tools).toHaveLength(1);expect(sent.tools[0].function.strict).toBe(true);
 expect(askQuestionToolBytes()).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(sent.tools)));
 expect(sent.tools[0].function.parameters.properties.question.maxLength).toBe(500);
 expect(sent.tools[0].function.parameters.properties.options.maxItems).toBe(5);
 expect(sent.provider.only).toEqual(['deepinfra/fp8']);
 expect(sent).not.toHaveProperty('parallel_tool_calls');expect(sent).not.toHaveProperty('tool_choice');
});
it.each(modes.flatMap(mode=>['',null,'   '].map(content=>({mode,content}))))(
 'successful empty output reaches v5 fallback only when enabled ($mode, $content)',async({mode,content})=>{
 const allowed=await agentTurn(mode,completion({content}),{firstToolCallOnly:true,allowEmptyResult:true});
 expect((await allowed.run).trim()).toBe('');expect(allowed.exchange).toHaveBeenCalledTimes(1);
 const legacy=await agentTurn(mode,completion({content}));
 await expect(legacy.run).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
});

it('v5 empty-result allowance never turns an exchange failure into a completed reply',async()=>{
 const failed=runRuntime({model:'m/x',instructions:'I',input:'hello',session:session(),
  maxOutputTokens:100,maxTurns:1,tools:[askQuestionTool()],stream:true,allowEmptyResult:true,
  firstToolCallOnly:true,stopAtToolNames:['ask_question'],reasoning:{parameter:'none'},
  selectHistory:async(_history,incoming)=>incoming,exchange:async()=>{throw new Error('synthetic network failure');}});
 await expect(failed).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
});

it.each(modes.flatMap(mode=>['content_filter','stop'].map(finish=>({mode,finish}))))(
 'v5 fallback never converts refusal into success ($mode, $finish)',async({mode,finish})=>{
 const refused=await agentTurn(mode,completion({content:null,refusal:'Synthetic refusal'},finish),
  {firstToolCallOnly:true,allowEmptyResult:true});
 await expect(refused.run).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
 expect(refused.exchange).toHaveBeenCalledTimes(1);
});

it.each(modes)('v5 rejects content_filter even without a refusal text (%s)',async mode=>{
 const blocked=await agentTurn(mode,completion({content:''},'content_filter'),
  {firstToolCallOnly:true,allowEmptyResult:true});
 await expect(blocked.run).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
});

describe('v5 one-turn Session writes commit only after SDK success',()=>{
 it('discards the SDK input-only append on a pending exchange; legacy persistence stays unchanged',async()=>{
  for(const buffered of [false,true]){
   const added:AgentInputItem[][]=[];
   const store:Session={...session(),addItems:async items=>{added.push(items);}};
   await expect(runRuntime({model:'m/x',instructions:'I',input:'hello',session:store,
    maxOutputTokens:100,maxTurns:1,tools:[askQuestionTool()],stream:true,
    firstToolCallOnly:true,commitSessionOnSuccess:buffered,stopAtToolNames:['ask_question'],
    selectHistory:async(_history,incoming)=>incoming,
    exchange:async()=>{throw new Error('RUNTIME_RESPONSE_PENDING');},
   })).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
   if(buffered)expect(added).toEqual([]);
   else expect(added).toEqual([[{type:'message',role:'user',content:'hello'}]]);
  }
 });
 it('does not flush after completed exchange whose output fails validation',async()=>{
  const turn=await agentTurn('stream',completion({content:'   '}),
   {firstToolCallOnly:true,commitSessionOnSuccess:true});
  await expect(turn.run).rejects.toThrow('RUNTIME_EXECUTION_PENDING');expect(turn.added).toEqual([]);
 });
 it('successful terminal card flushes complete batches identically on saved-response replay',async()=>{
  const prior:AgentInputItem={role:'user',content:'Frozen previous turn'};
  const response=completion({content:'先分析。',tool_calls:[askCall('saved_card')]},'tool_calls');
  const histories:AgentInputItem[][][]=[];const requests:string[]=[];
  for(const live of [true,false]){
   let toolFinished=false;
   const batches:AgentInputItem[][]=[];
   const store:Session={...session(),getItems:async()=>[prior],addItems:async items=>{
    expect(toolFinished).toBe(true);batches.push(structuredClone(items));
   }};
   const output=await runRuntime({model:'m/x',instructions:'I',input:'hello',session:store,
    maxOutputTokens:100,maxTurns:1,stream:true,firstToolCallOnly:true,commitSessionOnSuccess:true,
    stopAtToolNames:['ask_question'],tools:[{...askQuestionTool(),execute:async args=>{
     toolFinished=true;return askQuestionTool().execute(args,'saved_card');
    }}],selectHistory:async(history,incoming)=>{
     expect(history[0]).toBe(prior);return [...history,...incoming];
    },exchange:async(_sequence,request,onChunk)=>{
     expect(batches).toEqual([]);requests.push(request);
     if(live)for(const frame of frames(response))onChunk!(frame);
     return JSON.stringify(response);
    }});
   expect(JSON.parse(output)).toEqual({card:'question',...card});
   expect(batches).toHaveLength(1);
   expect(batches[0]!.map(item=>'type' in item?item.type:undefined))
    .toEqual(expect.arrayContaining(['function_call','function_call_result']));
   histories.push(batches);
  }
  expect(histories[1]).toEqual(histories[0]);expect(requests[1]).toBe(requests[0]);
 });
 it('a lost successful append response is retried as the same full batch',async()=>{
  const saved:AgentInputItem[][]=[];let loseReply=true;const requests:string[]=[];
  const response=completion({content:'已收到完整回执。'});
  async function run(){
   let batch=0;
   const store:Session={...session(),addItems:async items=>{
    if(saved[batch])expect(items).toEqual(saved[batch]);else saved[batch]=structuredClone(items);
    batch++;
    if(loseReply){loseReply=false;throw new Error('Synthetic lost append acknowledgement');}
   }};
   return runRuntime({model:'m/x',instructions:'I',input:'hello',session:store,
    maxOutputTokens:100,maxTurns:1,stream:true,tools:[askQuestionTool()],
    firstToolCallOnly:true,commitSessionOnSuccess:true,stopAtToolNames:['ask_question'],
    selectHistory:async(_history,incoming)=>incoming,
    exchange:async(_sequence,request)=>{requests.push(request);return JSON.stringify(response);}});
  }
  await expect(run()).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
  const persisted=structuredClone(saved);
  expect(await run()).toBe('已收到完整回执。');
  expect(saved).toEqual(persisted);expect(saved).toHaveLength(1);expect(requests[1]).toBe(requests[0]);
 });
 it.each([{maxTurns:2,firstToolCallOnly:true},{maxTurns:1,firstToolCallOnly:false}])(
  'refuses buffered persistence outside a v5 one-call turn %#',async limits=>{
   const exchange=vi.fn();
   await expect(runRuntime({model:'m/x',instructions:'I',input:'hello',session:session(),
    ...limits,maxOutputTokens:100,tools:[],stream:true,commitSessionOnSuccess:true,
    selectHistory:async(_history,incoming)=>incoming,exchange,
   })).rejects.toThrow('RUNTIME_CONTEXT_INVALID');expect(exchange).not.toHaveBeenCalled();
  });
});
