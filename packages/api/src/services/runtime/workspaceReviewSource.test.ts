/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {resolvePostSource,OWN_POSTS_RESERVE,postResultBytes} from './workspacePosts';
import {postgresJsonbBytes} from './payloadSize';
const actor='10000000-0000-4000-8000-000000000001',own='10000000-0000-4000-8000-000000000002';
const benchmark='10000000-0000-4000-8000-000000000003',now=Date.parse('2026-10-18T12:00:00Z');
it('retains all review connection dependencies and Gold rights while fitting persisted JSON bytes',async()=>{
 const metrics=Object.fromEntries(Array.from({length:50},(_,i)=>['m'+i,1e21]));
 const posts=Array.from({length:30},(_,i)=>({id:'benchmark-'+i,connectionId:benchmark,postedAt:'2026-10-09T00:00:00Z',
  source:'tikhub',titleExcerpt:'"\\\n'.repeat(40)}));
 const rpc=vi.fn(async(name:string)=>{
  if(name==='publish_monitor_data')return {error:null,data:{windowDays:14,posts:[],connections:[{id:own,platform:'youtube',status:'connected',
   lastSuccessAt:null,refreshDay:null,refreshState:null,refreshError:null,autoTrack:false,delayed:false,manualRefreshAt:null}]}};
  if(name==='publish_monitor_review_supplement')return {error:null,data:{connections:[{id:benchmark,platform:'youtube'}],posts,
   histories:posts.map(p=>({postId:p.id,snapshots:['2026-10-10','2026-10-12','2026-10-16'].map(capturedOn=>({
    capturedOn,metrics,missingFields:['views'],source:'tikhub'}))})),followers:[]}};
  throw new Error('Unexpected RPC or supplier refresh');
 });
 const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 try{
  const result=await resolvePostSource({rpc},actor,{kind:'workspace_posts_request',entitled:true,windowDays:14,review:true});
  expect(result).toMatchObject({kind:'my_posts',gold_review:true,source_connections:[own,benchmark],truncated:true});
  expect(postgresJsonbBytes(result)).toBeLessThanOrEqual(11000);
  expect(postResultBytes(result)).toBeLessThanOrEqual(11000);
  const calls=Array.from({length:2},()=>({type:'function_call_output',call_id:'c'.repeat(256),output:JSON.stringify(result)}));
  expect(Buffer.byteLength(JSON.stringify(calls))).toBeLessThanOrEqual(OWN_POSTS_RESERVE);
  expect(rpc.mock.calls.map(([name])=>name)).toEqual(['publish_monitor_data','publish_monitor_review_supplement']);
 }finally{clock.mockRestore();}
});
