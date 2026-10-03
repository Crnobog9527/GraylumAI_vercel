/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {recoverOpenRouterHistory,assertLatestHistoryRetained} from './historyRecovery';
import {SOURCE_TOOL_NAMES} from './agentTools';
import {projectOpenRouterItemsForSizing} from './openRouterHistory';
const user={role:'user',content:'Synthetic question'};
const answer={role:'assistant',content:'Synthetic answer'};
const invalid={role:'assistant',content:[{type:'output_text',text:'Synthetic answer',providerData:{plugins:[]}}]};
it('cuts the incompatible old turn and prefix, preserving the original safe suffix objects',()=>{
 const history=[user,invalid,user,answer],copy=structuredClone(history);
 const selected=recoverOpenRouterHistory(history,SOURCE_TOOL_NAMES);
 expect(selected).toEqual([user,answer]);expect(selected[0]).toBe(user);expect(selected[1]).toBe(answer);
 expect(history).toEqual(copy);
});
it.each([
 [user,invalid],
 [user,{type:'function_call',callId:'a',name:'unknown_tool',arguments:'{}'}],
 [user,{type:'function_call_result',callId:'a',output:'Synthetic output'}],
 [user,{type:'function_call',callId:'a',name:'read_source',arguments:'{}'},user,
  {type:'function_call_result',callId:'a',name:'read_source',output:'Synthetic output'}],
])('rejects rather than discarding the most recent turn (%j)',(...history)=>{
 expect(()=>recoverOpenRouterHistory(history,SOURCE_TOOL_NAMES)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
 expect(()=>projectOpenRouterItemsForSizing(history,0,SOURCE_TOOL_NAMES)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
it('does not cut valid history',()=>{
 const history=[user,answer];expect(recoverOpenRouterHistory(history,SOURCE_TOOL_NAMES)).toEqual(history);
});

it('allows an originally empty history but never empties a damaged one',()=>{
 expect(recoverOpenRouterHistory([],SOURCE_TOOL_NAMES)).toEqual([]);
 expect(()=>recoverOpenRouterHistory([invalid],SOURCE_TOOL_NAMES)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});

it('rejects if subsequent capacity selection removes any of the latest recovered turn',()=>{
 const earlier={role:'user',content:'Earlier'},latest={role:'user',content:'Latest'};
 const history=[earlier,invalid,latest,answer];
 const recovered=recoverOpenRouterHistory(history,SOURCE_TOOL_NAMES);
 expect(()=>assertLatestHistoryRetained(history,recovered)).not.toThrow();
 for(const selected of [[],[answer],[latest]])
  expect(()=>assertLatestHistoryRetained(history,selected)).toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
});
