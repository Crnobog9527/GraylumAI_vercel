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
 expect(sourceWorkSummary({kind:'workspace_index',entries:[{body:'PRIVATE'}]})).toBeNull();
});

it('does not turn a failed read into success or leak its raw error',async()=>{
 const emit=vi.fn(),error=new Error('PRIVATE RPC ERROR');
 const tool=withSourceWorkProgress({name:'read_source',description:'read',execute:async()=>{throw error;}},emit);
 await expect(tool.execute({query:'doc-1/segment-2'},'c2')).rejects.toBe(error);
 expect(emit.mock.calls.map(([event])=>event.state)).toEqual(['running','pending']);
 expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE');
});

it('keeps index browsing and other tools out of the source work stream, and ignores a disconnected viewer',async()=>{
 const emit=vi.fn();
 const tool=withSourceWorkProgress({name:'read_source',description:'read',
  execute:async()=>JSON.stringify({kind:'library_directory'})},emit);
 await tool.execute({query:'doc-1'},'c3');
 expect(emit).not.toHaveBeenCalled();
 const other={name:'other',description:'other',execute:async()=>''};
 expect(withSourceWorkProgress(other,emit)).toBe(other);
 const disconnected=withSourceWorkProgress({...other,name:'read_source',
  execute:async()=>JSON.stringify({kind:'library_segment',title:'片段'})},()=>{throw new Error('disconnect');});
 await expect(disconnected.execute({query:'doc-1/segment-1'},'c4')).resolves.toContain('library_segment');
});

it('leaves a successful raw tool result untouched when a display summary cannot parse it',async()=>{
 const emit=vi.fn();
 const original='not JSON; successful original tool output';
 const tool=withSourceWorkProgress({name:'read_source',description:'read',execute:async()=>original},emit);
 await expect(tool.execute({query:'search:资料'},'raw')).resolves.toBe(original);
 expect(emit.mock.calls.map(([event])=>event.state)).toEqual(['running','pending']);
 expect(JSON.stringify(emit.mock.calls)).not.toContain(original);
});
