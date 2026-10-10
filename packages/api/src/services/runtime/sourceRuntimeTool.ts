/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {RuntimeTool} from './runner';
import type {ToolRpc} from './skillFileExecution';
import type {runtimeContext} from './runtimeContext';
export function sourceRuntimeTool(options: {
 name: string; context: z.infer<typeof runtimeContext>; args: {p_execution_id: string};
 ownerRpc: ToolRpc; budget: {assertCanStart: () => void}; execution: {live?: boolean; sessionId: string};
 exchange: (request: string, phase: string) => Promise<{usage?: {toolResult?: unknown}}>;
}): RuntimeTool {
 const {name,context,args,ownerRpc,budget,execution,exchange}=options;
 return {name,description:name==='search'?'Search current sources through the explicitly enabled local search adapter.':
  context.workspaceContext?'Read owned business context only when relevant. Omit query to list account/topic metadata; '+
   'pass an exact returned id to read that source. Read-only; no internet access.':'Read the selected source only.',
    execute:async(arguments_,callId)=>{
     budget.assertCanStart();
     const toolArgs={...args,p_call_id:callId,p_name:name,p_arguments:arguments_};
     const saved=await ownerRpc<{execute:boolean;result:unknown}>('runtime_tool',{...toolArgs,p_action:'claim'});
     if(name==='read_source'){
      if(context.workspaceContext){
       if(saved.result!==null)return JSON.stringify(saved.result);
       const source=await ownerRpc<unknown>('runtime_workspace_source',{
        p_session_id:execution.sessionId,p_query:typeof arguments_.query==='string'?arguments_.query:''});
       const committed=await ownerRpc<{result:unknown}>('runtime_tool',{...toolArgs,p_action:'complete',p_result:source});
       return JSON.stringify(committed.result);
      }
      if(!context.sources?.length||Object.keys(arguments_).length)throw new Error('RUNTIME_SOURCE_ARGUMENT_DENIED');
      const source=await ownerRpc<unknown>('runtime_source',{p_source:context.sources[0]});
      if(saved.result!==null){
       if(JSON.stringify(saved.result)!==JSON.stringify(source))throw new Error('RUNTIME_SOURCE_CHANGED');
       return JSON.stringify(source);
      }
      await ownerRpc('runtime_tool',{...toolArgs,p_action:'complete',p_result:source});
      return JSON.stringify(source);
     }
     // Increment/replay the original billed tool phase even when the result was saved.
     // This keeps following model call identities deterministic after SDK replay.
     const envelope=await exchange(JSON.stringify({tool:name,arguments:arguments_}), 'tool:'+name);
     if(saved.result!==null)return JSON.stringify(saved.result);
     if(!execution.live&&!saved.execute&& !envelope.usage?.toolResult)throw new Error('RUNTIME_TOOL_PENDING');
     const result=z.object({body:z.string().max(20000),sources:z.array(z.object({
      id:z.string(),version:z.string(),status:z.literal('available'),
     }).strict()).max(32)}).strict().parse(envelope.usage?.toolResult);
     const committed=await ownerRpc<{result:unknown}>('runtime_tool',{...toolArgs,p_action:'complete',p_result:result});
     // Use the persisted JSON representation on first execution as on replay.
     // JSONB reorders object keys; serializing the pre-write object would alter
     // the next SDK request bytes after recovery despite identical tool data.
     return JSON.stringify(committed.result);
    }};
}
