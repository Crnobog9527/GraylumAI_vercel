/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {it,expect,vi} from 'vitest';
import {executionTools} from './executionTools';
import {sourceWorkSummary,withSourceWorkProgress} from './sourceWorkProgress';
const execution={sessionId:'11111111-1111-4111-8111-111111111111',live:true};
// #1131: a read can start and finish between the five-second persisted-view polls.
it('streams a search start before its RPC resolves and a safe summary after it commits',async()=>{
 const events:unknown[]=[];
 let release!:(value:unknown)=>void;
 const read=new Promise(resolve=>{release=resolve;});
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_tool'&&args.p_action==='claim')return {execute:true,result:null};
  if(name==='runtime_library_read')return read;
  if(name==='runtime_tool')return {result:args.p_result};
 });
 const built=executionTools({executionId:'22222222-2222-4222-8222-222222222222',agentTurn:false,grounded:false,fiveFields:false,
  sources:()=>({current:'',user:[]}),research:null,onRefused:()=>{},context:{tools:['read_source'],libraryRetrieval:true} as never,
  args:{p_execution_id:'22222222-2222-4222-8222-222222222222'},ownerRpc:rpc as never,
  budget:{assertCanStart:()=>{}},execution,exchange:async()=>({}),onProgress:(event:unknown)=>events.push(event)}).tools[0]!;
 const running=built.execute({query:'search:定位'},'call-live');
 await vi.waitFor(()=>expect(events).toContainEqual({type:'agent_tool',callId:'call-live',tool:'read_source',
  kind:'library_search',state:'running',label:''}));
 release({kind:'library_search',hits:[{documentId:'d1',title:'定位资料',excerpt:'SECRET BODY'},
  {documentId:'d1',title:'定位资料',excerpt:'SECRET BODY'}],terms:['定位'],internal:'SECRET'});
 await running;
 expect(events.at(-1)).toEqual({type:'agent_tool',callId:'call-live',tool:'read_source',kind:'library_search',
  state:'done',label:'在资料库里找到 1 篇相关内容',detail:'定位资料'});
 expect(JSON.stringify(events)).not.toContain('SECRET');
});

it('only publishes whitelisted summaries for positioning, benchmarks, segments and empty searches',()=>{
 expect(sourceWorkSummary({kind:'workspace_source',identity:{kind:'positioning',name:'摄影'},body:'PRIVATE'}))
  .toEqual({kind:'positioning',state:'done',label:'读了你确认的定位',detail:'摄影'});
 expect(sourceWorkSummary({kind:'workspace_source',identity:{kind:'benchmarks'},body:'PRIVATE'}))
  .toEqual({kind:'my_benchmarks',state:'done',label:'看了你的对标账号数据'});
 expect(sourceWorkSummary({kind:'library_segment',title:'第一段',body:'PRIVATE'}))
  .toEqual({kind:'library_read',state:'done',label:'读了一段资料',detail:'第一段'});
 expect(sourceWorkSummary({kind:'library_search',hits:[],terms:['选题','摄影']}))
  .toEqual({kind:'library_search',state:'missing',label:'资料库里没找到相关内容',detail:'搜索词：选题 摄影'});
 expect(sourceWorkSummary({kind:'library_index',documents:[{title:'PRIVATE'},{title:'PRIVATE'}]}))
  .toEqual({kind:'library_search',state:'done',label:'看了你的资料库（2 篇）'});
 expect(sourceWorkSummary({kind:'library_directory',documentId:'PRIVATE',entries:[{title:'PRIVATE'}]}))
  .toEqual({kind:'library_search',state:'done',label:'看了你的资料库（1 篇）'});
 expect(sourceWorkSummary({kind:'workspace_index',entries:[{body:'PRIVATE'}]})).toBeNull();
});

it('does not turn a failed read into success or leak its raw error',async()=>{
 const emit=vi.fn(),error=new Error('PRIVATE RPC ERROR');
 const tool=withSourceWorkProgress({name:'read_source',description:'read',execute:async()=>{throw error;}},emit);
 await expect(tool.execute({query:'doc-1/segment-2'},'c2')).rejects.toBe(error);
 expect(emit.mock.calls.map(([event])=>event.state)).toEqual(['running','pending']);
 expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE');
});

it('streams library index and directory progress as safe library-search events',async()=>{
 const emit=vi.fn();
 for (const [query,result,count] of [
  ['',{kind:'library_index',documents:[{title:'PRIVATE'}]},1],
  ['library',{kind:'library_index',documents:[]},0],
  ['doc-1',{kind:'library_directory',documentId:'PRIVATE',entries:[]},1],
  ['doc-1/page-2',{kind:'library_directory',documentId:'PRIVATE',entries:[]},1],
 ] as const) {
  emit.mockClear();
  const tool=withSourceWorkProgress({name:'read_source',description:'read',execute:async()=>JSON.stringify(result)},
   emit,false,{libraryRetrieval:true});
  await tool.execute({query},'c3');
  expect(emit.mock.calls.map(([event])=>[event.kind,event.state])).toEqual([
   ['library_search','running'],['library_search','done'],
  ]);
  expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({label:`看了你的资料库（${count} 篇）`});
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE');
 }
 const workspaceOnly=withSourceWorkProgress({name:'read_source',description:'read',
  execute:async()=>JSON.stringify({kind:'workspace_index',entries:[]})},emit,false,
  {workspaceContext:true,libraryRetrieval:true});
 emit.mockClear();
 await workspaceOnly.execute({query:''},'workspace-index');
 expect(emit).not.toHaveBeenCalled();
 const other={name:'other',description:'other',execute:async()=>''};
 expect(withSourceWorkProgress(other,emit)).toBe(other);
 const disconnected=withSourceWorkProgress({...other,name:'read_source',
  execute:async()=>JSON.stringify({kind:'library_segment',title:'片段'})},()=>{throw new Error('disconnect');});
 await expect(disconnected.execute({query:'doc-1/segment-1'},'c4')).resolves.toContain('library_segment');
});

it('keeps unrelated reads out of the source work stream and ignores a disconnected viewer',async()=>{
 const emit=vi.fn();
 const tool=withSourceWorkProgress({name:'read_source',description:'read',
  execute:async()=>JSON.stringify({kind:'unavailable',reason:'unknown_query'})},emit);
 await tool.execute({query:'other'},'c3');
 expect(emit).not.toHaveBeenCalled();
 const other={name:'other',description:'other',execute:async()=>''};
 expect(withSourceWorkProgress(other,emit)).toBe(other);
});

it('leaves a successful raw tool result untouched when a display summary cannot parse it',async()=>{
 const emit=vi.fn();
 const original='not JSON; successful original tool output';
 const tool=withSourceWorkProgress({name:'read_source',description:'read',execute:async()=>original},emit);
 await expect(tool.execute({query:'search:资料'},'raw')).resolves.toBe(original);
 expect(emit.mock.calls.map(([event])=>event.state)).toEqual(['running','pending']);
 expect(JSON.stringify(emit.mock.calls)).not.toContain(original);
});

it('summarizes own-post states without publishing metrics, titles, raw notes or supplier details',()=>{
 const source={kind:'my_posts',status:'available',window_days:14,posts:[{title:'PRIVATE',views:999,source:'SUPPLIER'}],note:'RAW $12'};
 expect(sourceWorkSummary(source)).toEqual({kind:'my_posts',state:'done',label:'读了你最近 14 天的 1 条作品'});
 expect(JSON.stringify(sourceWorkSummary(source))).not.toMatch(/PRIVATE|999|SUPPLIER|RAW|\$/);
 expect(sourceWorkSummary({...source,status:'not_connected'})).toMatchObject({state:'missing',label:'未取到：还没有连接账号'});
 expect(sourceWorkSummary({...source,status:'no_entitlement'})).toMatchObject({state:'missing',label:'读你的作品数据是 Pro/Gold 会员功能，这次先按定位和资料回答'});
 expect(sourceWorkSummary({...source,status:'no_recent_posts'})).toMatchObject({state:'missing',label:'最近 14 天没有新作品'});
 expect(sourceWorkSummary({...source,status:'stale',as_of:'2026-10-10'})).toMatchObject({state:'pending',label:'数据截至 2026-10-10，最近一次快照已超过 3 天。'});
 expect(sourceWorkSummary({...source,status:'stale',as_of:'PRIVATE'})).toMatchObject({state:'pending',label:'还没有取到作品快照，指标未取到。'});
 expect(sourceWorkSummary({...source,window_days:null})).toMatchObject({state:'pending',label:'作品数据待核实'});
});

it('streams own-post progress only for a frozen capability and preserves the exact committed result',async()=>{
 const emit=vi.fn(),result=JSON.stringify({kind:'my_posts',status:'available',window_days:30,posts:[]});
 const raw={name:'read_source',description:'read',execute:async()=>result};
 const tool=withSourceWorkProgress(raw,emit,true);
 await expect(tool.execute({query:'my_posts:30'},'own')).resolves.toBe(result);
 expect(emit.mock.calls.map(([event])=>[event.kind,event.state])).toEqual([['my_posts','running'],['my_posts','done']]);
 const disabled=vi.fn();
 await withSourceWorkProgress({...raw,execute:async()=>JSON.stringify({kind:'unavailable'})},disabled).execute({query:'my_posts:30'},'off');
 expect(disabled).not.toHaveBeenCalled();
 const limit=vi.fn();
 await withSourceWorkProgress({...raw,execute:async()=>JSON.stringify({kind:'unavailable',reason:'read_limit'})},limit,true)
  .execute({query:'my_posts:30'},'limit');
 expect(limit.mock.calls.at(-1)?.[0]).toMatchObject({state:'missing',label:'本条回答的作品读取次数已用完'});
 const capacity=vi.fn();
 await withSourceWorkProgress({...raw,execute:async()=>JSON.stringify({kind:'unavailable',reason:'capacity_exhausted'})},capacity,true)
  .execute({query:'my_posts:30'},'capacity');
 expect(capacity.mock.calls.at(-1)?.[0]).toMatchObject({state:'missing',label:'资料太多放不下，先按已读到的回答'});
});
