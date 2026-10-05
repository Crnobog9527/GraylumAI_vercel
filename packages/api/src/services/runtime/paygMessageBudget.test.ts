/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {AgentInputItem} from '@openai/agents';
import {expect,it} from 'vitest';
import {freezePaygMessageBudget} from './paygMessageBudget';
import type {FrozenRun} from '../bill2/service';
import {selectRuntimeHistory} from './context';
const policies=[{modelId:'primary',payg:{maxMessages:32}},{modelId:'summary',payg:{maxMessages:32}}] as FrozenRun['callPolicy'];
it('trims more than 32 history items and reserves read_source second-round messages',()=>{
 const context={modelId:'primary',historyItems:100,maxTurns:3,maxToolCalls:2,
  attachedOrganizer:{modelId:'summary',historyItems:100}};
 freezePaygMessageBudget(context,policies);
 expect(context.historyItems).toBe(22);expect(context.attachedOrganizer.historyItems).toBe(30);
 const history=Array.from({length:100},(_,i)=>({role:i%2?'assistant':'user',content:'synthetic'}));
 const selected=selectRuntimeHistory(history,[{role:'user',content:'current'}],{
  instructions:'test',inputBytes:100000,toolBytes:0,historyItems:context.historyItems});
 expect(selected.length+1+4*context.maxToolCalls).toBeLessThanOrEqual(32);
});
it('rejects impossible tool-round budgets before admission',()=>{
 expect(()=>freezePaygMessageBudget({modelId:'primary',historyItems:100,maxTurns:32,maxToolCalls:8},policies))
  .toThrow('BILL2_INPUT_PROFILE_INVALID');
});

it('real SDK read_source second round fits the same frozen message cap with 100 history items',async()=>{
 const {runRuntime}=await import('./runner');
 const history:AgentInputItem[]=Array.from({length:100},(_,i)=>i%2?{role:'assistant',status:'completed',
  content:[{type:'output_text',text:'Synthetic history'}]}:{role:'user',content:'Synthetic history'});
 const context={modelId:'primary',historyItems:100,maxTurns:2,maxToolCalls:1};
 freezePaygMessageBudget(context,policies);
 const counts:number[]=[];
 const session={getSessionId:async()=> 'synthetic',getItems:async()=>history,addItems:async()=>{},
  popItem:async()=>undefined,clearSession:async()=>{}};
 const result=await runRuntime({model:'test/model',instructions:'Read the owned source, then answer.',input:'Read source',session,
  maxOutputTokens:8192,maxTurns:2,tools:[{name:'read_source',description:'Read owned synthetic source',execute:async()=> 'Source content'}],
  selectHistory:async(h,i)=>selectRuntimeHistory(h,i,{instructions:'Read',inputBytes:100000,toolBytes:0,historyItems:context.historyItems}),
  exchange:async(_sequence,body)=>{
   const request=JSON.parse(body);counts.push(request.messages.length);
   expect(request.messages.length).toBeLessThanOrEqual(32);
   return JSON.stringify({id:`round-${counts.length}`,object:'chat.completion',created:1,model:'test/model',choices:[{index:0,
    finish_reason:counts.length===1?'tool_calls':'stop',message:counts.length===1?
     {role:'assistant',content:'I will read the source.',tool_calls:[{id:'source-1',type:'function',function:{name:'read_source',arguments:'{}'}}]}:
     {role:'assistant',content:'Complete answer'}}]});
  }});
 expect(result).toBe('Complete answer');expect(counts).toHaveLength(2);expect(counts[1]).toBeGreaterThan(counts[0]);
});
