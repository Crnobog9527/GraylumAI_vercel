/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Agent, Runner, OpenAIChatCompletionsModel, tool, type Session, type AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import {OPENROUTER_RESPONSE_TIMEOUT_MS} from '../bill2/openRouterPolicy';
import type {ReasoningPolicy} from './reasoningPolicy';

export type RuntimeTool = {
  name: string; description: string; execute: (arguments_: Record<string, unknown>, callId: string) => Promise<string>;
  /** Defaults to the original optional `query` string used by every older tool. */
  parameters?: z.ZodObject<z.ZodRawShape>;
  /** When set, invalid arguments or a failed execution become this tool result
   * instead of failing the run. Unset (every older tool) keeps failing it. */
  invalidResult?: string;
};
const defaultToolParameters=z.object({query:z.string().max(2000).optional()}).strict();
export type RuntimeRunnerInput = {
  model: string; instructions: string; input: string; session: Session;
  maxOutputTokens: number; maxTurns: number;
  /** Frozen admission policy; the SDK emits it as Chat Completions reasoning_effort. */
  reasoning?: ReasoningPolicy;
  /** Authenticated host rechecks frozen context, persists claim, and dispatches once.
   * During recovery this callback may only return the original stored response. */
  exchange: (sequence: number, body: string, onChunk?: (chunk: string) => void) => Promise<string>;
  stream?: boolean;
  onText?: (delta:string)=>void;
  selectHistory: (history: unknown[], incoming: unknown[]) => Promise<unknown[]>;
  filterModelInput?: (items: AgentInputItem[], instructions: string) => AgentInputItem[];
  tools: RuntimeTool[];
  signal?: AbortSignal;
  /** New interactive format only (AC-1). A listed tool ends the turn after it runs. */
  stopAtToolNames?: readonly string[];
  /** New interactive format only: several calls in one response keep the first
   * call before the SDK sees them; the provider response stays unchanged as
   * evidence. Older formats reject such a response. Also omits the optional
   * parallel_tool_calls hint, which no catalogued route supports. */
  firstToolCallOnly?: boolean;
  onToolCallsDropped?: (dropped:number)=>void;
};
type ToolCalls=unknown[]|null|undefined;
/** One response message, with only its first tool call when that is allowed. */
function keepFirstCall<T extends {tool_calls?:ToolCalls}>(message:T,input:RuntimeRunnerInput):T{
  const calls=message.tool_calls;
  if(!input.firstToolCallOnly||!Array.isArray(calls)||calls.length<2)return message;
  input.onToolCallsDropped?.(calls.length-1);
  return {...message,tool_calls:calls.slice(0,1)};
}
/** A cut-off response that still carries a tool call may hold partial
 * arguments. The new format never executes it; older formats are unchanged. */
function truncatedToolTurn(decoded:{choices?:Array<{finish_reason?:unknown;message?:{tool_calls?:ToolCalls}}>},input:RuntimeRunnerInput){
  const choice=decoded.choices?.[0],calls=choice?.message?.tool_calls;
  return Boolean(input.firstToolCallOnly&&choice?.finish_reason==='length'&&Array.isArray(calls)&&calls.length);
}
/** Stream frames reach the SDK with only the first call's deltas (new format). */
function firstCallFrame(chunk:string,input:RuntimeRunnerInput):string{
  if(!input.firstToolCallOnly)return chunk;
  const frame=JSON.parse(chunk),delta=frame?.choices?.[0]?.delta;
  if(!delta||!Array.isArray(delta.tool_calls))return chunk;
  const kept=delta.tool_calls.filter((call:{index?:unknown})=>call?.index===0);
  if(kept.length===delta.tool_calls.length)return chunk;
  if(kept.length)delta.tool_calls=kept;else delete delta.tool_calls;
  return JSON.stringify(frame);
}
const batchDenied=(calls:unknown,input:RuntimeRunnerInput)=>calls!=null&&(!Array.isArray(calls)||calls.length>1&&!input.firstToolCallOnly);

/** Only the final empty-length protocol shape; reasoning is never an answer. */
export function emptyTruncatedResponse(decoded:unknown):boolean{
 if(!decoded||typeof decoded!=='object')return false;
 const choices=(decoded as {choices?:Array<{finish_reason?:unknown;message?:{role?:unknown;content?:unknown;tool_calls?:unknown}}>}).choices;
 if(!Array.isArray(choices)||choices.length!==1)return false;
 const choice=choices[0],content=choice?.message?.content,calls=choice?.message?.tool_calls;
 return choice?.message?.role==='assistant'&&choice.finish_reason==='length'&&(content===null||content===undefined||typeof content==='string'&&!content.trim())&&(calls===undefined||calls===null||Array.isArray(calls)&&calls.length===0);
}

/** One official SDK loop for all roles. No SDK trace, remote Session, fallback or retry. */
export async function runRuntime(input: RuntimeRunnerInput) {
  let sequence=0,outputTruncated=false;
  const guardedFetch: typeof fetch = async (url, init) => {
    if(String(url)!=='http://127.0.0.1/runtime/chat/completions') throw new Error('RUNTIME_TRANSPORT_DENIED');
    const body=JSON.parse(String(init?.body));
    if(body.model!==input.model||Boolean(body.stream)!==Boolean(input.stream)||body.store!==false||'reasoning' in body||body.reasoning_effort!==input.reasoning?.effort||
      'tool_choice' in body||input.firstToolCallOnly&&'parallel_tool_calls' in body||++sequence>input.maxTurns) throw new Error('RUNTIME_CALL_DENIED');
    if(input.stream){
      const encoder=new TextEncoder();
      const stream=new ReadableStream<Uint8Array>({start(controller){
        let open=true,received=false;
        const emit=(chunk:string)=>{if(open)try{controller.enqueue(encoder.encode('data: '+chunk+'\n\n'));}catch{open=false;}};
        void input.exchange(sequence,JSON.stringify(body),chunk=>{received=true;emit(firstCallFrame(chunk,input));}).then(raw=>{
          const response=JSON.parse(raw);
          const calls=response.choices?.[0]?.message?.tool_calls;
          if(response.choices?.length!==1||batchDenied(calls,input))throw new Error('RUNTIME_TOOL_BATCH_DENIED');
          if(emptyTruncatedResponse(response)||truncatedToolTurn(response,input)){outputTruncated=true;throw new Error('RUNTIME_OUTPUT_TRUNCATED');}
          // Replay streams only already-persisted output, never redispatches.
          if(!received){const choice=response.choices[0];emit(JSON.stringify({...response,object:'chat.completion.chunk',choices:[{index:0,delta:keepFirstCall(choice.message,input),finish_reason:choice.finish_reason}]}));}
          else if(input.firstToolCallOnly&&Array.isArray(calls)&&calls.length>1)input.onToolCallsDropped?.(calls.length-1);
          if(open){controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();open=false;}
        }).catch(error=>{if(open){controller.error(error);open=false;}});
      }});
      return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
    }
    const response=await input.exchange(sequence,JSON.stringify(body));
    // parallel_tool_calls is a provider hint, not an execution boundary. Reject
    // an entire multi-tool response before the SDK can invoke any local tool.
    const decoded=JSON.parse(response),calls=decoded.choices?.[0]?.message?.tool_calls;
    if(!Array.isArray(decoded.choices)||decoded.choices.length!==1||batchDenied(calls,input))throw new Error('RUNTIME_TOOL_BATCH_DENIED');
    if(emptyTruncatedResponse(decoded)||truncatedToolTurn(decoded,input)){
      // A final, empty, length-limited response cannot be repaired by replaying it.
      // Never expose reasoning as an answer or let the SDK start another turn.
      outputTruncated=true;
      throw new Error('RUNTIME_OUTPUT_TRUNCATED');
    }
    const kept=Array.isArray(calls)&&calls.length>1
      ?JSON.stringify({...decoded,choices:[{...decoded.choices[0],message:keepFirstCall(decoded.choices[0].message,input)}]}):response;
    return new Response(kept,{status:200,headers:{'content-type':'application/json'}});
  };
  // Align the SDK wrapper budget with the host's bounded read plus SQL.
  // The host adapter owns the network deadline; guardedFetch does not forward
  // the SDK signal or use it to interrupt durable evidence writes.
  const client=new OpenAI({apiKey:'local-fixture-only',baseURL:'http://127.0.0.1/runtime',fetch:guardedFetch,maxRetries:0,timeout:OPENROUTER_RESPONSE_TIMEOUT_MS+30_000});
  const model=new OpenAIChatCompletionsModel(client,input.model,{strictFeatureValidation:true});
  const tools=input.tools.map(t=>tool({name:t.name,description:t.description,
    parameters:t.parameters??defaultToolParameters,errorFunction:t.invalidResult===undefined?null:()=>t.invalidResult!,
    execute:async(args,_context,details)=>{
      const callId=details?.toolCall?.callId;
      if(!callId)throw new Error('RUNTIME_TOOL_ID_REQUIRED');
      return t.execute(args,callId);
    }}));
  const agent=new Agent({name:'Graylum Runtime',model,instructions:input.instructions,tools,
    ...(input.stopAtToolNames?.length?{toolUseBehavior:{stopAtToolNames:[...input.stopAtToolNames]}}:{}),
    modelSettings:{store:false,maxTokens:input.maxOutputTokens,...(input.firstToolCallOnly?{}:{parallelToolCalls:false}),retry:{maxRetries:0},
      ...(input.reasoning?{reasoning:{effort:input.reasoning.effort}}:{})}});
  const runner=new Runner({model,tracingDisabled:true,traceIncludeSensitiveData:false});
  try{
    const options={session:input.session,maxTurns:input.maxTurns,
      signal:input.signal,sessionInputCallback:async(history:AgentInputItem[],incoming:AgentInputItem[])=>await input.selectHistory(history,incoming) as typeof history,
      ...(input.filterModelInput?{callModelInputFilter:({modelData}:{modelData:{input:AgentInputItem[];instructions?:string}})=>({
        ...modelData,input:input.filterModelInput!(modelData.input,modelData.instructions??input.instructions),
      })}:{})};
    const result=input.stream?await runner.run(agent,input.input,{...options,stream:true}):await runner.run(agent,input.input,options);
    if(input.stream){
      const streamed=result as Awaited<ReturnType<typeof runner.run>> & {toTextStream():ReadableStream<string>;completed:Promise<void>};
      for await(const text of streamed.toTextStream())input.onText?.(text);
      await streamed.completed;
    }
    if(typeof result.finalOutput!=='string'||!result.finalOutput.trim())throw new Error('RUNTIME_EMPTY_RESULT');
    return result.finalOutput;
  }catch(error){
    if(outputTruncated)throw new Error('RUNTIME_OUTPUT_TRUNCATED');
    if(error instanceof Error&&['RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY','RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY'].includes(error.message))throw error;
    throw new Error('RUNTIME_EXECUTION_PENDING');
  }
}
