/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {selectBlockHistory,currentInputBytes} from './historySelection';
import {selectRuntimeHistory,runtimeScopeInput} from './context';
import {freezeHistorySelection,type HostTurnContext} from './hostTurn';
import {askQuestionToolBytes} from './agentTools';
const host:HostTurnContext={stepId:'s1',opening:false,checklist:Array.from({length:3},(_,step)=>({
 id:'s'+step,title:'Synthetic step',fields:Array.from({length:8},(_,field)=>({id:'f'+field,title:'Synthetic field',
  required:true,role:'user_fact',status:'draft',protected:false})),
}))};
const incoming=(inputLength:number,materialLength:number)=>[{role:'user',content:runtimeScopeInput('u'.repeat(inputLength),
 {sessionId:'synthetic',revision:1,hash:'0'.repeat(64),content:{material:'m'.repeat(materialLength)}},host)}];
const history=Array.from({length:160},(_,i)=>({role:i%2?'assistant':'user',content:'h'.repeat(i%2?1600:600)}));
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const frozen=freezeHistorySelection();
it('reports short/long input retention and fallback frequency on a declared synthetic distribution',()=>{
 const rows=[];
 for(const inputBytes of [64000,90000])for(const length of [100,13000]){
  const current=incoming(length,4000);
  const options={instructions:'S'.repeat(16000),inputBytes,historyItems:100,toolBytes:askQuestionToolBytes(true)+150,
   historySelection:frozen,revisions:history.map((_,i)=>i+1)};
  const selected=selectBlockHistory(history,current,options).slice(0,-1);
  const legacy=selectRuntimeHistory(history,current,options).slice(0,-1);
  rows.push({inputBytes,inputChars:length,currentBytes:currentInputBytes(current),fallback:currentInputBytes(current)>frozen.currentReserveBytes,
   oldItems:legacy.length,oldBytes:bytes(legacy),newItems:selected.length,newBytes:bytes(selected)});
  // At least eight full exchanges at the conservative 64 KB fixture ceiling.
  expect(selected.length).toBeGreaterThanOrEqual(16);
 }
 const samples=[100,1000,8000,13000].flatMap(length=>[1000,4000,8000].map(material=>currentInputBytes(incoming(length,material))));
 const report={reserve:frozen.currentReserveBytes,rows,sampleBytes:samples,
  fallbackSamples:samples.filter(size=>size>frozen.currentReserveBytes).length,totalSamples:samples.length};
 expect(report).toMatchSnapshot();
 console.info('H1_CAPACITY_REPORT '+JSON.stringify(report));
});
