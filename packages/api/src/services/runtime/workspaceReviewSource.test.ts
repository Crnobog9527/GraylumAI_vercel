/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {resolvePostSource,OWN_POSTS_RESERVE,postResultBytes} from './workspacePosts';
import {postgresJsonbBytes} from './payloadSize';
const actor='10000000-0000-4000-8000-000000000001',own='10000000-0000-4000-8000-000000000002';
const benchmark='10000000-0000-4000-8000-000000000003',now=Date.parse('2026-10-18T12:00:00Z');
it.each([['own',8],['benchmark',2],['benchmark',50]] as const)('trims complete %s review groups (%i metrics) with matching rankings and bounded bytes',async(mode,count)=>{
 const metrics=Object.fromEntries(Array.from({length:count},(_,i)=>['m'+i,1e21]));
 const posts=Array.from({length:30},(_,i)=>({id:'20000000-0000-4000-8000-'+String(i).padStart(12,'0'),
  connectionId:mode==='own'?own:benchmark,postedAt:'2026-10-09T00:00:00Z',source:'tikhub',titleExcerpt:'"\\\n'.repeat(40)}));
 const snapshots=['2026-10-10','2026-10-12','2026-10-16'].map(capturedOn=>({capturedOn,metrics,missingFields:['views'],source:'tikhub'}));
 const rpc=vi.fn(async(name:string,args?:Record<string,unknown>)=>{
  if(name==='publish_monitor_data')return {error:null,data:{windowDays:14,posts:mode==='own'?posts.map(p=>({...p,
   url:null,postedAtSource:'provider',firstSeenAt:p.postedAt,workItemId:null,
   latest:{capturedOn:'2026-10-18',metrics:{views:1},missingFields:[],breakdowns:{}}})):[],
   connections:[{id:own,platform:'youtube',status:'connected',lastSuccessAt:null,refreshDay:null,refreshState:null,
    refreshError:null,autoTrack:false,delayed:false,manualRefreshAt:null}]}};
  if(name==='publish_monitor_post_history')return {error:null,data:{postId:args!.p_post_id,snapshots}};
  if(name==='publish_monitor_review_supplement')return {error:null,data:{connections:mode==='benchmark'?[{id:benchmark,platform:'youtube'}]:[],
   posts:mode==='benchmark'?posts:[],histories:mode==='benchmark'?posts.map(p=>({postId:p.id,snapshots})):[],followers:[]}};
  throw new Error('Unexpected RPC or supplier refresh');
 });
 const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 try{
  const result=await resolvePostSource({rpc},actor,{kind:'workspace_posts_request',entitled:true,windowDays:14,review:true});
  expect(result).toMatchObject({kind:'my_posts',source_connections:mode==='benchmark'?[own,benchmark]:[own],truncated:true});
  if(mode==='benchmark')expect(result).toMatchObject({gold_review:true});
  type Review=ReturnType<typeof import('../publishMonitor/reviewData').alignedReview>;
  const review=(result as {review:Review&{benchmarks:Review}}).review;
  const projection=mode==='own'?review:review.benchmarks,rows=projection.rows;
  expect(rows.length).toBeLessThan(90);
  for(const id of new Set(rows.map(r=>r.postId)))expect(rows.filter(r=>r.postId===id).map(r=>r.ageDays)).toEqual([1,3,7]);
  for(const [key,ranking] of Object.entries(projection.rankings))for(const ranked of ranking)
   expect(rows.some(row=>row.postId===ranked.postId&&Object.keys(row.comparisons).some(metric=>
    [row.connectionId,row.source,row.ageDays,metric].join(':')===key))).toBe(true);
  expect(postgresJsonbBytes(result)).toBeLessThanOrEqual(11000);expect(postResultBytes(result)).toBeLessThanOrEqual(11000);
  const calls=Array.from({length:2},()=>({type:'function_call_output',call_id:'c'.repeat(256),output:JSON.stringify(result)}));
  expect(Buffer.byteLength(JSON.stringify(calls))).toBeLessThanOrEqual(OWN_POSTS_RESERVE);
  expect(new Set(rpc.mock.calls.map(([name])=>name))).toEqual(new Set(mode==='own'
   ?['publish_monitor_data','publish_monitor_post_history','publish_monitor_review_supplement']:['publish_monitor_data','publish_monitor_review_supplement']));
 }finally{clock.mockRestore();}
});

it.each(['2026-10-14',null])('keeps freshness consistent when review enrichment clips posts (%s)',async capturedOn=>{
 const connection={id:own,platform:'youtube',status:'connected',lastSuccessAt:null,refreshDay:null,refreshState:null,
  refreshError:null,autoTrack:false,delayed:false,manualRefreshAt:null};
 const posts=Array.from({length:9},(_,i)=>({id:'20000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  connectionId:own,postedAt:i<8?'2026-10-17T00:00:00Z':null,source:'tikhub',titleExcerpt:'title'.repeat(24),
  url:null,postedAtSource:i<8?'provider':null,firstSeenAt:i<8?'2026-10-17T00:00:00Z':'2026-10-16T00:00:00Z',workItemId:null,
  latest:i===8||capturedOn?{capturedOn:i===8?'2026-10-18':capturedOn,metrics:{views:i+1},missingFields:[],breakdowns:{}}:null}));
 const rpc=vi.fn(async(name:string,args?:Record<string,unknown>)=>{
  if(name==='publish_monitor_data')return {error:null,data:{windowDays:14,connections:[connection],posts}};
  if(name==='publish_monitor_post_history')return {error:null,data:{postId:args!.p_post_id,snapshots:[]}};
  if(name==='publish_monitor_review_supplement')return {error:null,data:{connections:[],posts:[],histories:[],
   followers:[]}};
  throw new Error('Unexpected RPC or supplier refresh');
 });
 const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 try{
  const result=await resolvePostSource({rpc},actor,{kind:'workspace_posts_request',entitled:true,windowDays:14,review:true});
  expect(result).toMatchObject({kind:'my_posts',truncated:true,status:'stale',as_of:capturedOn});
  expect((result as {posts:Array<{id:string}>}).posts.map(p=>p.id)).toEqual(posts.slice(0,2).map(p=>p.id));
  expect((result as {platform_medians:unknown}).platform_medians).toEqual(capturedOn?{youtube:{views:{median:1.5,samples:2}}}:{});
  expect((result as {note:string}).note).toBe(capturedOn?'数据截至 2026-10-14，最近一次快照已超过 3 天。':'还没有取到作品快照，指标未取到。');
  expect(postResultBytes(result)).toBeLessThanOrEqual(11000);
 }finally{clock.mockRestore();}
});
