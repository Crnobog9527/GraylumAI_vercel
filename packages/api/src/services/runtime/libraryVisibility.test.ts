/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {executionVisibility} from './libraryVisibility';
import {streamOriginalExecution,type ExecutionStreamEvent} from './executionStream';
import type {RuntimeProgress} from './progress';
import {observeContext} from './executorRpc';

const actor='10000000-0000-4000-8000-000000000001',execution='10000000-0000-4000-8000-000000000002';
const VISIBILITY='runtime_execution_visibility';
/** The combined fence (DB-PERF PR-2A): one call per check; `live` covers both sources unless one is set on its own. */
function database(state:{live:boolean;error?:boolean;voiceLive?:boolean;libraryLive?:boolean;erased?:boolean}){
 const calls:string[]=[],sources:{voice:unknown;library:unknown}[]=[];
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push(name);
  if(name!==VISIBILITY)throw new Error(name);
  expect(args).toEqual({p_actor_id:actor,p_execution_id:execution,p_voice:expect.any(Boolean),p_library:expect.any(Boolean)});
  sources.push({voice:args.p_voice,library:args.p_library});
  if(state.erased)return {data:null,error:{code:'42501',message:'CONTENT_ERASED'}};
  if(state.error&&(args.p_voice||args.p_library))return {data:null,error:{code:'57014',message:'timeout'}};
  if(args.p_voice&&!(state.voiceLive??state.live))return {data:'voice',error:null};
  if(args.p_library&&!(state.libraryLive??state.live))return {data:'library',error:null};
  return {data:'visible',error:null};
 });
 return {calls,sources,client:{rpc} as unknown as SupabaseClient};
}

it('an execution without library references only asks for the content check, still once per check',async()=>{
 const db=database({live:false}),fence=executionVisibility(db.client,actor,execution);
 fence.observe({});await fence.visible();fence.observe({libraryReferences:[]});await fence.visible();
 expect(db.calls).toEqual([VISIBILITY,VISIBILITY]);
 expect(db.sources).toEqual([{voice:false,library:false},{voice:false,library:false}]);
});

it('PR-2A: one round trip per check covers content, voice and library together; each source is refused on its own',async()=>{
 const state={live:true} as Parameters<typeof database>[0],db=database(state),fence=executionVisibility(db.client,actor,execution);
 fence.observe({libraryReferences:[{documentId:execution,version:1}],voiceBound:true});
 await fence.visible();
 expect(db.calls).toEqual([VISIBILITY]);
 expect(db.sources).toEqual([{voice:true,library:true}]);
 state.libraryLive=false; // only the referenced document is deleted
 await expect(fence.visible()).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
 state.libraryLive=true;state.voiceLive=false; // only the voice version is deleted
 await expect(fence.visible()).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
 state.voiceLive=true;state.erased=true; // the conversation is erased: the content refusal comes first, as before
 await expect(fence.visible()).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:'CONTENT_ERASED'});
 expect(db.calls).toEqual([VISIBILITY,VISIBILITY,VISIBILITY,VISIBILITY]);
});

it('PR-2A: an answer of unknown shape fails closed',async()=>{
 const rpc=vi.fn(async()=>({data:true,error:null}));
 const fence=executionVisibility({rpc} as unknown as SupabaseClient,actor,execution);
 fence.observe({libraryReferences:[{}]});
 await expect(fence.visible()).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
});

it('a referencing execution is refused with a stable code once its source is gone, and fails closed on errors',async()=>{
 const state={live:true},db=database(state),fence=executionVisibility(db.client,actor,execution);
 fence.observe({libraryReferences:[{documentId:execution,version:1}]});
 await fence.visible();
 state.live=false;
 await expect(fence.visible()).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
 const broken=executionVisibility(database({live:true,error:true}).client,actor,execution);
 broken.observe({libraryReferences:[{}]});
 await expect(broken.visible()).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
});

it('the stream shows nothing produced after the deletion: text, native deltas, phases or the result',async()=>{
 const state={live:true},db=database(state),fence=executionVisibility(db.client,actor,execution);
 let emit!:(event:RuntimeProgress)=>void,finish!:()=>void;
 const done=new Promise<void>(resolve=>{finish=resolve;});
 const run=async(onProgress:(event:RuntimeProgress)=>void)=>{
  fence.observe({libraryReferences:[{documentId:execution,version:1}]});emit=onProgress;await done;
  return {state:'completed' as const,body:'LATE_PRIVATE_ANSWER'};
 };
 let now=0;
 const stream=streamOriginalExecution(run,undefined,'runtime.executeStream',()=>now,'textDelta-v1',fence.visible);
 const seen:ExecutionStreamEvent[]=[];
 const first=stream.next();
 await vi.waitFor(()=>expect(emit).toBeDefined());
 emit({type:'text',text:'Early',delta:'Early'} as RuntimeProgress);
 seen.push((await first).value as ExecutionStreamEvent);
 // The document is deleted; everything the provider produces afterwards stays on the server.
 state.live=false;now+=1000;
 emit({type:'text',text:'Early LATE_PRIVATE_TEXT',delta:' LATE_PRIVATE_TEXT'} as RuntimeProgress);
 emit({type:'phase',phase:'organizer'} as RuntimeProgress);
 finish();
 const rest=(async()=>{for await(const event of stream)seen.push(event);})();
 await expect(rest).rejects.toMatchObject({message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
 expect(JSON.stringify(seen)).toContain('Early');
 expect(JSON.stringify(seen)).not.toMatch(/LATE_PRIVATE|organizer|result/);
});

it('PR-2A: a conversation erased while the reply streams shows nothing more, through the same combined check',async()=>{
 const state={live:true} as Parameters<typeof database>[0],db=database(state),fence=executionVisibility(db.client,actor,execution);
 let emit!:(event:RuntimeProgress)=>void,finish!:()=>void;
 const done=new Promise<void>(resolve=>{finish=resolve;});
 const run=async(onProgress:(event:RuntimeProgress)=>void)=>{
  fence.observe({libraryReferences:[{documentId:execution,version:1}],voiceBound:true});emit=onProgress;await done;
  return {state:'completed' as const,body:'LATE_PRIVATE_ANSWER'};
 };
 let now=0;
 const stream=streamOriginalExecution(run,undefined,'runtime.executeStream',()=>now,'textDelta-v1',fence.visible);
 const seen:ExecutionStreamEvent[]=[];
 const first=stream.next();
 await vi.waitFor(()=>expect(emit).toBeDefined());
 emit({type:'text',text:'Early',delta:'Early'} as RuntimeProgress);
 seen.push((await first).value as ExecutionStreamEvent);
 state.erased=true;now+=1000;
 emit({type:'text',text:'Early LATE_PRIVATE_TEXT',delta:' LATE_PRIVATE_TEXT'} as RuntimeProgress);
 finish();
 const rest=(async()=>{for await(const event of stream)seen.push(event);})();
 await expect(rest).rejects.toMatchObject({message:'CONTENT_ERASED'});
 expect(JSON.stringify(seen)).not.toMatch(/LATE_PRIVATE|result/);
 expect(new Set(db.calls)).toEqual(new Set([VISIBILITY]));
});

it('the executor reports references as soon as the execution is read, before recovery branches; never for a completed answer',()=>{
 const seen:unknown[]=[];
 const options={onContext:(context:{libraryReferences?:unknown[]})=>{seen.push(context.libraryReferences);}} as Parameters<typeof observeContext>[0];
 const references=[{documentId:execution,version:1}];
 for(const state of ['running','cost_pending','waiting_resume','cancelled'])observeContext(options,{state,context:{libraryReferences:references}});
 observeContext(options,{state:'completed',context:{libraryReferences:references}});
 observeContext(options,{state:'running',context:{}});
 expect(seen).toEqual([references,references,references,references,undefined]);
});

it('C (#1022 P1): a version change is not a deletion: the stream keeps showing the round, as a refresh will', async () => {
 // The document still exists at a newer version: runtime_library_visible rejects the frozen version, 0277 lists nothing,
 // so the combined check answers 'visible'.
 const rpc = vi.fn(async (): Promise<{ data: unknown; error: null }> => ({ data: 'visible', error: null }));
 const fence = executionVisibility({ rpc } as unknown as SupabaseClient, actor, execution);
 fence.observe({ libraryReferences: [{ documentId: execution, version: 1 }] });
 await expect(fence.visible()).resolves.toBeUndefined();
 // A deletion is still refused.
 rpc.mockImplementation(async () => ({ data: 'library', error: null }));
 await expect(fence.visible()).rejects.toMatchObject({ message: expect.stringMatching(/^LIB_SOURCE_DELETED：/) });
});

it('VOICE (Owner: deleted means unusable, also for the run in progress): a run bound to a voice version shows nothing once it is gone',async()=>{
 const state={live:true},db=database(state),fence=executionVisibility(db.client,actor,execution);
 fence.observe({});await fence.visible();
 expect(db.sources).toEqual([{voice:false,library:false}]); // not bound: no extra check
 fence.observe({voiceBound:true});
 await fence.visible();
 state.live=false;
 await expect(fence.visible()).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
 const broken=executionVisibility(database({live:true,error:true}).client,actor,execution);
 broken.observe({voiceBound:true});
 await expect(broken.visible()).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
});

it('the executor reports a frozen voice version to the fence',()=>{
 const seen:unknown[]=[];
 observeContext({onContext:(context:unknown)=>seen.push(context)} as never,{state:'running',context:{voiceProfile:{versionId:execution}}});
 observeContext({onContext:(context:unknown)=>seen.push(context)} as never,{state:'running',context:{voiceProfile:{}}});
 expect(seen).toEqual([expect.objectContaining({voiceBound:true}),expect.objectContaining({voiceBound:false})]);
});

