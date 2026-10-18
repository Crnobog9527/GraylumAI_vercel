/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {sourceRuntimeTool} from './sourceRuntimeTool';
import {WORKSPACE_STRATEGY_GUIDE} from './primaryInstructions';

const execution={sessionId:'11111111-1111-4111-8111-111111111111',live:true};
function tool(workspaceGuide?:string){
 const calls:string[]=[];
 const ownerRpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push(name);
  if(name==='runtime_tool'&&args.p_action==='claim')return {execute:true,result:null};
  if(name==='runtime_tool')return {result:args.p_result};
  return {kind:'workspace_source',body:'STRATEGY'};
 });
 const built=sourceRuntimeTool({name:'read_source',context:{workspaceContext:true,...(workspaceGuide?{workspaceGuide}:{})} as never,
  args:{p_execution_id:'22222222-2222-4222-8222-222222222222'},ownerRpc:ownerRpc as never,budget:{assertCanStart:()=>{}},execution,
  exchange:async()=>({})});
 return {built,calls,ownerRpc};
}

// Review P1 (#1129): without the strategy guide the execution reserved no room for a strategy result: it is never read.
it('does not read a strategy report when the execution froze no strategy guide',async()=>{
 const f=tool();
 const result=JSON.parse(await f.built.execute({query:'strategy_report:33333333-3333-4333-8333-333333333333'},'call-1'));
 expect(result).toMatchObject({kind:'unavailable'});
 expect(f.calls).not.toContain('runtime_workspace_source');
});
it('reads a strategy report when the strategy guide is frozen, and other ids either way',async()=>{
 const guided=tool(WORKSPACE_STRATEGY_GUIDE);
 expect(JSON.parse(await guided.built.execute({query:'strategy_report:33333333-3333-4333-8333-333333333333'},'call-2'))).toMatchObject({body:'STRATEGY'});
 expect(guided.calls).toContain('runtime_workspace_source');
 const plain=tool();
 await plain.built.execute({query:'44444444-4444-4444-8444-444444444444'},'call-3');
 expect(plain.calls).toContain('runtime_workspace_source');
});

it.each([true,false])('rechecks saved own-post visibility before replay (%s)',async visible=>{
 const saved={kind:'my_posts',status:'available',posts:[{views:12345}],source_connections:['connection']};
 const rpc=vi.fn(async(name:string)=>{
  if(name==='runtime_tool')return {execute:false,result:saved};
  if(name==='runtime_workspace_posts_visible')return visible;
  throw new Error('Replay must not reread sources or suppliers');
 });
 const built=sourceRuntimeTool({name:'read_source',context:{workspaceContext:true,ownPosts:true} as never,
  args:{p_execution_id:'22222222-2222-4222-8222-222222222222'},ownerRpc:rpc as never,
  budget:{assertCanStart:()=>{}},execution,exchange:async()=>{throw new Error('No provider call');}});
 expect(JSON.parse(await built.execute({query:'my_posts:14'},'saved-call')))
  .toEqual(visible?saved:{kind:'unavailable',reason:'source_deleted'});
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['runtime_tool','runtime_workspace_posts_visible']);
});
