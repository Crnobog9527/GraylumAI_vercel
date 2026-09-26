/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SessionRpc} from './session';

export async function readRuntimeView(database:SessionRpc,actorId:string,sessionId:string){
 const view=await database.rpc('runtime_view',{p_actor_id:actorId,p_session_id:sessionId});
 if(view.error)throw new Error('RUNTIME_VIEW_DENIED');
 return view.data as {sessionId:string;executions:Array<{executionId:string;unavailableReason?:string|null}>};
}

/** Reuse the original authorized read projection. No table grants, new receipt
 * endpoint, SDK replay or provider request is needed to recover this diagnosis. */
function contentDenied(error:unknown){
 return typeof error==='object'&&error!==null&&'message' in error&&['RUNTIME_CONTEXT_REVOKED','RUNTIME_SCOPE_DENIED','BILL2_ACTOR_DENIED'].includes(String(error.message));
}
export async function retainedOutputReason(database:SessionRpc,actorId:string,executionId:string){
 const execution=await database.rpc('runtime_execution',{p_actor_id:actorId,p_execution_id:executionId,p_action:'read'});
 if(execution.error){
  // Financial maintenance remains possible after source revocation, but its
  // receipt-derived diagnosis must not bypass the original content boundary.
  if(contentDenied(execution.error))return undefined;
  throw new Error('RUNTIME_OUTCOME_UNAVAILABLE');
 }
 const sessionId=(execution.data as {sessionId:string}).sessionId;
 const projected=await database.rpc('runtime_view',{p_actor_id:actorId,p_session_id:sessionId});
 if(projected.error){if(contentDenied(projected.error))return undefined;throw new Error('RUNTIME_OUTCOME_UNAVAILABLE');}
 const view=projected.data as Awaited<ReturnType<typeof readRuntimeView>>;
 return view.executions.find(e=>e.executionId===executionId)?.unavailableReason==='output_truncated'?'output_truncated' as const:undefined;
}
