/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {StagingAccessError,stagingRpcFailure,type StagingFailure} from './stagingErrors';
import {sourceToolBytes} from './sourceRuntimeTool';
import {LIBRARY_INSTRUCTIONS} from './primaryInstructions';

/**
 * LIB-4b (LIB_DOCS_PLAN 6.1): library documents the user referenced with @ travel in their own request field, never in
 * `sources` and never as text. Admission only shapes and gates them; runtime_admit's 0262 trigger checks every document
 * (own, ready, not deleting, current version) and freezes it with the execution in the same transaction.
 */
export const LIBRARY_REFERENCE_LIMIT=5;
/** The largest single library read result (0262), reserved so an admitted turn can read at least one segment. */
export const LIBRARY_RESULT_BYTES=16384;
/** Per-execution read ceiling of 0262; the frozen tool budget is the smaller of this and the turns left. */
const LIBRARY_READS=8;
/** Server switch (system_settings), off unless set to true. The composer switch alone never enables reading. */
export const LIBRARY_AGENT_READ_KEY='library_agent_read_enabled';

/** Optional: clients and pages that never send it keep working ([] when absent). */
export const libraryReferenceInput=z.array(z.object({kind:z.literal('library_document'),documentId:z.string().uuid(),
 version:z.number().int().positive().max(999999999)}).strict()).max(20).optional();
type ReferenceInput=NonNullable<z.infer<typeof libraryReferenceInput>>;
export type LibraryReference={documentId:string;version:number};

/** Codes the 0262 freeze trigger raises inside runtime_admit; each refuses the whole turn before any charge. */
const SQL_REFUSALS=['LIB_REFERENCE_INVALID','LIB_REFERENCE_NOT_FOUND','LIB_REFERENCE_NOT_READY','LIB_REFERENCE_STALE'];
export function throwLibraryRefusal(error:{message?:string}|null|undefined){
 if(error?.message&&SQL_REFUSALS.includes(error.message))throw new StagingAccessError(error.message as StagingFailure);
}

/** Duplicates of one document count once; the same document at two versions is a malformed request. */
export function normalizeLibraryReferences(items:ReferenceInput|undefined):LibraryReference[]{
 const versions=new Map<string,number>();
 for(const item of items??[]){
  const id=item.documentId.toLowerCase(),seen=versions.get(id);
  if(seen!==undefined&&seen!==item.version)throw new StagingAccessError('LIB_REFERENCE_INVALID');
  versions.set(id,item.version);
 }
 if(versions.size>LIBRARY_REFERENCE_LIMIT)throw new StagingAccessError('LIB_REFERENCE_LIMIT');
 return [...versions].map(([documentId,version])=>({documentId,version}));
}

/**
 * Gate before any paid work. Only free conversation and a chosen Skill read references: OPC turns, organizing and reports
 * have no read_source. The caller already dropped an empty list, so old clients' stored requests (and replays) match.
 */
export async function admitLibraryReferences(admin:SupabaseClient,request:{references?:ReferenceInput;selection:{kind:string}},
 host:{opcTurnToken?:string;reportGeneration?:unknown}):Promise<LibraryReference[]>{
 if(!request.references?.length)return [];
 const references=normalizeLibraryReferences(request.references);
 if(host.opcTurnToken||host.reportGeneration||request.selection.kind==='organizer')
  throw new StagingAccessError('LIB_REFERENCE_UNSUPPORTED');
 const setting=await admin.from('system_settings').select('value').eq('key',LIBRARY_AGENT_READ_KEY).maybeSingle();
 if(setting.error)stagingRpcFailure(setting.error);
 const value=setting.data?.value;
 if(value!==true&&value!=='true')throw new StagingAccessError('LIB_REFERENCE_DISABLED');
 return references;
}

/** read_source slots: library reads may use every remaining turn up to 0262's ceiling; other sources keep theirs. */
export function readSourceSlots(references:LibraryReference[],primaryTurns:number,otherSlots:number){
 return references.length?Math.max(otherSlots,Math.min(LIBRARY_READS,primaryTurns-1)):otherSlots;
}

/** A matched Skill's sizing: its instructions already carry LIBRARY_INSTRUCTIONS (withPrimaryAddenda), so only the
 * read_source description (with the library guide when referenced) and the one-result reserve are added. */
export function candidateToolBytes(references:LibraryReference[],tools:string[],workspaceContext:boolean){
 return sourceToolBytes(tools,workspaceContext,references.length>0)+(references.length?LIBRARY_RESULT_BYTES:0);
}

/** Bytes a referencing turn needs beyond its required context: read_source's description, the library instructions and
 * one maximal read result. The executor sizes the same description and addendum; the result is the admission reserve. */
export function libraryReserveBytes(references:LibraryReference[],tools:string[],workspaceContext:boolean){
 if(!references.length)return 0;
 return sourceToolBytes(tools,workspaceContext,true)+Buffer.byteLength(LIBRARY_INSTRUCTIONS)+LIBRARY_RESULT_BYTES;
}
