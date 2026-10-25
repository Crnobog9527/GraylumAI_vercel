/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService,runtimeAdmission} from './admission';
import {stagingProcedureError} from './stagingErrors';
import {LIBRARY_AGENT_READ_KEY,LIBRARY_RESULT_BYTES,LIBRARY_RETRIEVAL_KEY,admitLibraryRetrieval,candidateToolBytes,libraryReserveBytes,normalizeLibraryReferences,readSourceSlots} from './libraryAdmission';
import {sourceToolBytes} from './sourceRuntimeTool';
import {LIBRARY_INSTRUCTIONS,LIBRARY_RETRIEVAL_INSTRUCTIONS,libraryAddendum,withPrimaryAddenda} from './primaryInstructions';

// LIB-4b admission: the separate `references` field, the server switch, refusals before any charge and the frozen shape.
vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const modelId='10000000-0000-4000-8000-000000000003',requestId='10000000-0000-4000-8000-000000000004';
const doc=(n:number)=>`20000000-0000-4000-8000-00000000000${n}`;
type Frozen=Record<string,unknown>&{request:{references?:unknown};instructions:string};
const ref=(n:number,version=1)=>({kind:'library_document' as const,documentId:doc(n),version});

function harness(options:{enabled?:unknown;settingError?:boolean;admitError?:string;inputLimit?:number;
 policy?:Record<string,unknown>}={}){
 const calls:string[]=[];let frozen:Frozen|undefined,settingReads=0;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push(name);
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId},dialogueModelId:modelId},error:null};
  if(name==='runtime_admission_replay')return {data:null,error:null};
  if(name==='runtime_workspace_session')return {data:true,error:null};
  if(name==='runtime_admit'){
   if(options.admitError)return {data:null,error:{code:'P0001',message:options.admitError}};
   frozen=args.p_payload as Frozen;return {data:{executionId:requestId},error:null};
  }
  throw new Error(name);
 });
 const from=(table:string)=>{
  const query={select:()=>query,eq:()=>query,
   // DB-PERF PR-3: admission reads all its settings, the library switch included, in one query.
   in:async(_column:string,keys:string[])=>{
    if(table!=='system_settings'||!keys.includes(LIBRARY_AGENT_READ_KEY))return {data:[],error:null};
    settingReads++;
    if(options.settingError)return {data:null,error:{code:'57014',message:'timeout'}};
    return {data:'enabled' in options?[{key:LIBRARY_AGENT_READ_KEY,value:options.enabled}]:[],error:null};
   },
   maybeSingle:async()=>{throw new Error('the library switch is read with the admission settings');},
   single:async()=>({data:{id:modelId,model_id:'fixture',provider:'fixture',is_active:'true',max_tokens:1000,
    input_limit:options.inputLimit??32000},error:null})};
  return query;
 };
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})}} as unknown as SupabaseClient;
 const admin={rpc,from} as unknown as SupabaseClient;
 const service=runtimeAdmissionService(user,admin,{workspaceContext:true,account:'test',costPerCall:'0.02',creditsPerUsd:'1000',
  multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:options.inputLimit??32000,historyItems:10,...options.policy});
 return {service,calls,frozen:()=>frozen,settingReads:()=>settingReads};
}
const message=(extra:Record<string,unknown>={})=>({sessionId,requestId,input:'Summarize my notes',
 selection:{kind:'ordinary',modelId},network:'deny',...extra});

it('an old client without references and one sending [] freeze the same payload, never read the switch',async()=>{
 const old=harness(),empty=harness();
 await old.service.prepare(message());await empty.service.prepare(message({references:[]}));
 expect(old.frozen()).toEqual(empty.frozen());
 expect(old.frozen()?.request).not.toHaveProperty('references');
 expect(old.frozen()).not.toHaveProperty('libraryReferences');
 expect(old.frozen()?.instructions).not.toContain('doc-1');
 expect(old.frozen()?.tools).toEqual(['read_source']);expect(old.frozen()?.maxToolCalls).toBe(2);
 // No read of its own: the switch is part of the one admission settings query each request makes anyway.
 expect(old.settingReads()+empty.settingReads()).toBe(2);
});

it('references freeze deduplicated in order with read_source and every remaining turn as read slots',async()=>{
 const h=harness({enabled:true,inputLimit:100000});
 await h.service.prepare(message({references:[ref(2),ref(1,3),ref(2)]}));
 expect(h.frozen()?.libraryReferences).toEqual([{documentId:doc(2),version:1},{documentId:doc(1),version:3}]);
 // The stored request keeps exactly what the client sent, so a resend with other references is another message.
 expect(h.frozen()?.request.references).toEqual([ref(2),ref(1,3),ref(2)]);
 expect(h.frozen()?.tools).toEqual(['read_source']);
 expect(h.frozen()?.maxToolCalls).toBe(2);expect(h.frozen()?.maxTurns).toBe(3);
 expect(h.settingReads()).toBe(1);
});

it('admits only as many read slots as the model capacity still holds results for',async()=>{
 // 32000 bytes of input capacity hold the required context and one maximal result, not two.
 const h=harness({enabled:true});
 await h.service.prepare(message({references:[ref(1)]}));
 expect(h.frozen()?.maxToolCalls).toBe(1);
});

it.each([
 ['switch missing',{},'LIB_REFERENCE_DISABLED'],
 ['switch false',{enabled:false},'LIB_REFERENCE_DISABLED'],
 ['switch unreadable',{settingError:true},'RUNTIME_STAGING_SERVICE_UNAVAILABLE'],
 ['an OPC turn',{enabled:true,policy:{opcTurnToken:requestId}},'LIB_REFERENCE_UNSUPPORTED'],
] as const)('refuses before runtime_admit: %s',async(_label,options,code)=>{
 const h=harness(options as Parameters<typeof harness>[0]);
 const error=await h.service.prepare(message({references:[ref(1)]})).catch(cause=>cause);
 expect(error).toMatchObject({reason:code});
 expect(h.calls).not.toContain('runtime_admit');
});

it('organizing never carries references',async()=>{
 const h=harness({enabled:true});
 await expect(h.service.prepare(message({references:[ref(1)],selection:{kind:'organizer'}})))
  .rejects.toMatchObject({reason:'LIB_REFERENCE_UNSUPPORTED'});
 expect(h.calls).not.toContain('runtime_admit');
});

it('limit and malformed references are refused; duplicates count once',()=>{
 expect(normalizeLibraryReferences([1,2,3,4,5,1,2].map(n=>ref(n)))).toHaveLength(5);
 expect(()=>normalizeLibraryReferences([1,2,3,4,5,6].map(n=>ref(n)))).toThrow('LIB_REFERENCE_LIMIT');
 expect(()=>normalizeLibraryReferences([ref(1,1),ref(1,2)])).toThrow('LIB_REFERENCE_INVALID');
 expect(normalizeLibraryReferences([{...ref(1),documentId:doc(1).toUpperCase()},ref(1)])).toHaveLength(1);
 for(const bad of [{...ref(1),path:'x'},{...ref(1),kind:'file'},{...ref(1),version:0},{...ref(1),documentId:'doc-1'},
  {documentId:doc(1),version:1}])
  expect(runtimeAdmission.safeParse(message({references:[bad]})).success).toBe(false);
 expect(runtimeAdmission.safeParse(message({references:Array.from({length:21},()=>ref(1))})).success).toBe(false);
});

it.each(['LIB_REFERENCE_NOT_FOUND','LIB_REFERENCE_NOT_READY','LIB_REFERENCE_STALE','LIB_REFERENCE_INVALID'])(
 'the 0262 trigger refusal %s keeps its stable code for the client',async code=>{
  const h=harness({enabled:true,admitError:code});
  const error=await h.service.prepare(message({references:[ref(1)]})).catch(cause=>cause);
  expect(error).toMatchObject({reason:code});
  expect(stagingProcedureError(error,'runtime.prepare').message.startsWith(code+'：')).toBe(true);
 });

it('a model too small for one read result refuses with the reference capacity code, not as a long input',async()=>{
 const h=harness({enabled:true,inputLimit:12000});
 await expect(h.service.prepare(message({references:[ref(1)]}))).rejects.toMatchObject({reason:'LIB_REFERENCE_CAPACITY'});
 // The same turn without references still fits.
 await harness({inputLimit:12000}).service.prepare(message());
});

it('the executor appends the library instructions only for an execution with references',()=>{
 expect(withPrimaryAddenda('base',{libraryReferences:[{documentId:doc(1),version:1}]})).toBe('base'+LIBRARY_INSTRUCTIONS);
 expect(withPrimaryAddenda('base',{})).toBe('base');
 expect(withPrimaryAddenda('base',{libraryReferences:[]})).toBe('base');
});

it('a matched Skill counts the library tool text and reserve once; its instructions already carry the addendum',()=>{
 const refs=[{documentId:doc(1),version:1}];
 expect(candidateToolBytes(refs,['read_source'],true)).toBe(sourceToolBytes(['read_source'],true,true)+LIBRARY_RESULT_BYTES);
 expect(candidateToolBytes([],['read_source'],true)).toBe(sourceToolBytes(['read_source'],true));
 expect(libraryReserveBytes(refs,['read_source'],true)-candidateToolBytes(refs,['read_source'],true)).toBe(Buffer.byteLength(LIBRARY_INSTRUCTIONS));
});

// Review P1 (#1116): every permitted library read keeps its result in the dialogue, so the read count must be paid for
// in the admission capacity check; otherwise a near-capacity turn is charged and then cannot build its next request.
it('limits library read slots to the results that still fit, never below one read',()=>{
 const refs=[{documentId:'00000000-0000-4000-8000-000000000001',version:1}];
 const fitsTwo=(extra:number)=>extra<=LIBRARY_RESULT_BYTES;
 expect(readSourceSlots(refs,10,0,()=>true)).toBe(8);
 expect(readSourceSlots(refs,10,0,fitsTwo)).toBe(2);
 expect(readSourceSlots(refs,10,0,()=>false)).toBe(1);
 expect(readSourceSlots(refs,10,2,()=>false)).toBe(1);
 expect(readSourceSlots(refs,3,0,()=>true)).toBe(2);
 expect(readSourceSlots([],10,2,()=>false)).toBe(2);
});

// CHAT-AUTO-CONTEXT A2: library retrieval of a plain free conversation.
it('retrieval sizing and slots: no references needed, the search guide and instructions are counted',()=>{
 expect(readSourceSlots([],10,0,()=>true,true)).toBe(8);
 expect(readSourceSlots([],10,0,()=>false,true)).toBe(1);
 expect(readSourceSlots([],10,2,()=>false,false)).toBe(2);
 expect(candidateToolBytes([],['read_source'],true,true)).toBe(sourceToolBytes(['read_source'],true,false,true)+LIBRARY_RESULT_BYTES);
 expect(candidateToolBytes([],['read_source'],true)).toBe(sourceToolBytes(['read_source'],true));
 expect(libraryReserveBytes([],['read_source'],true,true)-candidateToolBytes([],['read_source'],true,true))
  .toBe(Buffer.byteLength(LIBRARY_RETRIEVAL_INSTRUCTIONS));
 expect(libraryReserveBytes([],['read_source'],true)).toBe(0);
 // Both: the @ paragraph first, then the search paragraph; each alone is exactly its own text.
 expect(libraryAddendum(true,true)).toBe(LIBRARY_INSTRUCTIONS+LIBRARY_RETRIEVAL_INSTRUCTIONS);
 expect(libraryAddendum(false,true)).toBe(LIBRARY_RETRIEVAL_INSTRUCTIONS);
 expect(withPrimaryAddenda('base',{libraryRetrieval:true})).toBe('base'+LIBRARY_RETRIEVAL_INSTRUCTIONS);
});

it.each([
 ['both on',[true,'true'],true],['read off',[false,true],false],['search off',[true,false],false],['unset',[null,null],false],
])('retrieval switch: %s',async(_name,[read,search],expected)=>{
 const rows=[{key:LIBRARY_AGENT_READ_KEY,value:read},{key:LIBRARY_RETRIEVAL_KEY,value:search}].filter(row=>row.value!==null);
 const admin={from:()=>({select:()=>({in:async()=>({data:rows,error:null})})})} as unknown as SupabaseClient;
 expect(await admitLibraryRetrieval(admin,true,'ordinary',[])).toBe(expected);
});

it('retrieval is never offered to non-free-chat turns and does not read the switches for them',async()=>{
 const read=vi.fn();
 const admin={from:()=>({select:()=>({in:read})})} as unknown as SupabaseClient;
 expect(await admitLibraryRetrieval(admin,false,'ordinary',[])).toBe(false);
 expect(await admitLibraryRetrieval(admin,true,'skill',[])).toBe(false);
 expect(await admitLibraryRetrieval(admin,true,'ordinary',[false,true])).toBe(false);
 expect(read).not.toHaveBeenCalled();
});
