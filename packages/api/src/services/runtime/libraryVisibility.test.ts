/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {executionVisibility} from './libraryVisibility';
import {streamOriginalExecution,type ExecutionStreamEvent} from './executionStream';
import type {RuntimeProgress} from './progress';

const actor='10000000-0000-4000-8000-000000000001',execution='10000000-0000-4000-8000-000000000002';
function database(state:{live:boolean;error?:boolean}){
 const calls:string[]=[];
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push(name);
  if(name==='content_erasure_visible')return {data:true,error:null};
  if(name==='runtime_library_visible'){
   expect(args).toEqual({p_actor_id:actor,p_execution_id:execution,p_result:{kind:'library_index'}});
   return state.error?{data:null,error:{code:'57014',message:'timeout'}}:{data:state.live,error:null};
  }
  throw new Error(name);
 });
 return {calls,client:{rpc} as unknown as SupabaseClient};
}

it('an execution without library references only pays the content check',async()=>{
 const db=database({live:false}),fence=executionVisibility(db.client,actor,execution);
 fence.observe({});await fence.visible();fence.observe({libraryReferences:[]});await fence.visible();
 expect(db.calls).toEqual(['content_erasure_visible','content_erasure_visible']);
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
