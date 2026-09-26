/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Agent, Runner, OpenAIChatCompletionsModel, tool, type Session, type AgentInputItem } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

export type RuntimeTool = { name: string; description: string; execute: (arguments_: Record<string, unknown>, callId: string) => Promise<string> };
export type RuntimeRunnerInput = {
  model: string; instructions: string; input: string; session: Session;
  maxOutputTokens: number; maxTurns: number;
  /** Authenticated host rechecks frozen context, persists claim, and dispatches once.
   * During recovery this callback may only return the original stored response. */
  exchange: (sequence: number, body: string) => Promise<string>;
  selectHistory: (history: unknown[], incoming: unknown[]) => Promise<unknown[]>;
  filterModelInput?: (items: AgentInputItem[], instructions: string) => AgentInputItem[];
  tools: RuntimeTool[];
  signal?: AbortSignal;
};

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
    if(body.model!==input.model||body.stream||body.store!==false||++sequence>input.maxTurns) throw new Error('RUNTIME_CALL_DENIED');
    const response=await input.exchange(sequence,JSON.stringify(body));
    // parallel_tool_calls is a provider hint, not an execution boundary. Reject
    // an entire multi-tool response before the SDK can invoke any local tool.
    const decoded=JSON.parse(response),calls=decoded.choices?.[0]?.message?.tool_calls;
    if(!Array.isArray(decoded.choices)||decoded.choices.length!==1||
      (calls!==undefined&&calls!==null&&(!Array.isArray(calls)||calls.length>1)))throw new Error('RUNTIME_TOOL_BATCH_DENIED');
    if(emptyTruncatedResponse(decoded)){
      // A final, empty, length-limited response cannot be repaired by replaying it.
      // Never expose reasoning as an answer or let the SDK start another turn.
      outputTruncated=true;
      throw new Error('RUNTIME_OUTPUT_TRUNCATED');
    }
    return new Response(response,{status:200,headers:{'content-type':'application/json'}});
  };
  const client=new OpenAI({apiKey:'local-fixture-only',baseURL:'http://127.0.0.1/runtime',fetch:guardedFetch,maxRetries:0,timeout:45000});
  const model=new OpenAIChatCompletionsModel(client,input.model,{strictFeatureValidation:true});
  const tools=input.tools.map(t=>tool({name:t.name,description:t.description,
    parameters:z.object({query:z.string().max(2000).optional()}).strict(),errorFunction:null,
    execute:async(args,_context,details)=>{
      const callId=details?.toolCall?.callId;
      if(!callId)throw new Error('RUNTIME_TOOL_ID_REQUIRED');
      return t.execute(args,callId);
    }}));
  const agent=new Agent({name:'Graylum Runtime',model,instructions:input.instructions,tools,
    modelSettings:{store:false,maxTokens:input.maxOutputTokens,parallelToolCalls:false,retry:{maxRetries:0}}});
  const runner=new Runner({model,tracingDisabled:true,traceIncludeSensitiveData:false});
  try{
    const result=await runner.run(agent,input.input,{session:input.session,maxTurns:input.maxTurns,
      signal:input.signal,sessionInputCallback:async(history,incoming)=>await input.selectHistory(history,incoming) as typeof history,
      ...(input.filterModelInput?{callModelInputFilter:({modelData}:{modelData:{input:AgentInputItem[];instructions?:string}})=>({
        ...modelData,input:input.filterModelInput!(modelData.input,modelData.instructions??input.instructions),
      })}:{})});
    if(typeof result.finalOutput!=='string'||!result.finalOutput.trim())throw new Error('RUNTIME_EMPTY_RESULT');
    return result.finalOutput;
  }catch(error){
    if(outputTruncated)throw new Error('RUNTIME_OUTPUT_TRUNCATED');
    if(error instanceof Error&&['RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY','RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY'].includes(error.message))throw error;
    throw new Error('RUNTIME_EXECUTION_PENDING');
  }
}
