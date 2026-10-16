/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {contentVisibilityFence} from '../accountErasure/content';
import {StagingAccessError,stagingProcedureError,stagingRpcFailure} from './stagingErrors';

/** The frozen context fields the fence needs; the executor reports them before it can emit anything. */
export type ObservedContext={libraryReferences?:unknown[]};
export type ExecutionVisibility={visible:()=>Promise<void>;observe:(context:ObservedContext)=>void};

/**
 * LIB-4b (LIB_DOCS_PLAN 7, #981 acceptance): the recheck before anything of one execution is shown. Content erasure (D7)
 * applies to every execution. An execution that froze library references also shows nothing more (streamed text or
 * deltas, cards, phases, the result) once a referenced document is deleted or no longer at its frozen version: late
 * provider output is neither shown here nor stored by SQL (0262 cancels at the next runtime_execution action). Only an
 * execution the executor actually runs is observed, so replaying an answer completed before the deletion stays as D7 keeps it,
 * and an execution without references never pays the extra check.
 */
export function executionVisibility(database:SupabaseClient,actorId:string,executionId:string):ExecutionVisibility{
 const content=contentVisibilityFence(database,actorId,executionId);
 let referenced=false;
 return {
  observe(context){if(context.libraryReferences?.length)referenced=true;},
  async visible(){
   await content();
   if(!referenced)return;
   const live=await database.rpc('runtime_library_visible',
    {p_actor_id:actorId,p_execution_id:executionId,p_result:{kind:'library_index'}});
   try{if(live.error)stagingRpcFailure(live.error);}
   catch(cause){throw stagingProcedureError(cause,'runtime.libraryVisibility');}
   if(live.data!==true)throw stagingProcedureError(new StagingAccessError('LIB_SOURCE_DELETED'),'runtime.libraryVisibility');
  },
 };
}
