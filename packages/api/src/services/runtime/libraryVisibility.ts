/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {contentVisibilityFence} from '../accountErasure/content';
import {StagingAccessError,stagingProcedureError} from './stagingErrors';

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
   // One round trip (DB-PERF PR-2A): content erasure (D7), then -- only for what this execution froze -- the voice
   // version (VOICE, Owner 2026-10-23: a deleted voice must not be used, not even by the run in progress) and the
   // library references. Still checked on every call; the page already ends the stream and withdraws the text on this code.
   const gone=await content({voice:voiceBound,library:referenced});
   if(gone)throw stagingProcedureError(new StagingAccessError('LIB_SOURCE_DELETED'),
    gone==='voice'?'runtime.voiceVisibility':'runtime.libraryVisibility');
  },
 };
}
