/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {contentVisibilityFence} from '../accountErasure/content';
import {StagingAccessError,stagingProcedureError,stagingRpcFailure} from './stagingErrors';

/** The frozen context fields the fence needs; the executor reports them before it can emit anything. */
export type ObservedContext={libraryReferences?:unknown[];libraryRetrieval?:boolean;voiceBound?:boolean};
export type ExecutionVisibility={visible:()=>Promise<void>;observe:(context:ObservedContext)=>void};

/**
 * LIB-4b (LIB_DOCS_PLAN 7, #981 acceptance): the recheck before anything of one execution is shown. Content erasure (D7)
 * applies to every execution. An execution that froze library references also shows nothing more (streamed text or
 * deltas, cards, phases, the result) once a referenced document is deleted (0277, the 0262 entry check's test); a newer
 * content version is not a deletion and stays shown, as runtime.view shows it after a refresh (#1022 decision C): late
 * provider output is neither shown here nor stored by SQL (0262 cancels at the next runtime_execution action). Only an
 * execution the executor actually runs is observed, so replaying an answer completed before the deletion stays as D7 keeps it,
 * and an execution without references never pays the extra check.
 */
export function executionVisibility(database:SupabaseClient,actorId:string,executionId:string):ExecutionVisibility{
 const content=contentVisibilityFence(database,actorId,executionId);
 let referenced=false,voiceBound=false;
 return {
  observe(context){if(context.libraryReferences?.length||context.libraryRetrieval)referenced=true;if(context.voiceBound)voiceBound=true;},
  async visible(){
   await content();
   // VOICE (Owner 2026-10-23: a deleted voice must not be used, not even by the run in progress): a run bound to a
   // voice version also stops being shown at once when that version is deleted.
   if(voiceBound){
    const voiceGone=await database.rpc('runtime_voice_sources_gone',{p_actor_id:actorId,p_execution_ids:[executionId]});
    try{if(voiceGone.error)stagingRpcFailure(voiceGone.error);}
    catch(cause){throw stagingProcedureError(cause,'runtime.voiceVisibility');}
    if(!Array.isArray(voiceGone.data)||voiceGone.data.length)
     // The page already ends the stream and withdraws the text on this code.
     throw stagingProcedureError(new StagingAccessError('LIB_SOURCE_DELETED'),'runtime.voiceVisibility');
   }
   if(!referenced)return;
   const gone=await database.rpc('runtime_library_sources_gone',{p_actor_id:actorId,p_execution_ids:[executionId]});
   try{if(gone.error)stagingRpcFailure(gone.error);}
   catch(cause){throw stagingProcedureError(cause,'runtime.libraryVisibility');}
   if(!Array.isArray(gone.data)||gone.data.length)
    throw stagingProcedureError(new StagingAccessError('LIB_SOURCE_DELETED'),'runtime.libraryVisibility');
  },
 };
}
