/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {groundedCardToolBytes} from '../runtime/groundedCard';
import {expect,it} from 'vitest';
import {captureWorkflowSteps as steps} from '../__tests__/fixtures/captureWorkflow';
import {captureHostContext,captureOrganizerInput} from './captureContext';
import {agentTurnInstructions} from './agentTurnPrompt';
import {selectBlockHistory,currentInputBytes} from '../runtime/historySelection';
import {selectRuntimeHistory,runtimeScopeInput} from '../runtime/context';
import {freezeHistorySelection} from '../runtime/hostTurn';
const history=Array.from({length:160},(_,i)=>({role:i%2?'assistant':'user',content:'h'.repeat(i%2?1600:600)}));
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const frozen=freezeHistorySelection();
function material(width:number,notes=false) {
 const information=Object.fromEntries(steps.map(s=>[s.id,{schema:s.information,
  values:Object.fromEntries(s.information.map(f=>[f.id,{value:'中'.repeat(width),status:'provisional',nature:'fact'}])),
  notes:notes?Array.from({length:8},(_,i)=>({id:`synthetic-${i}`,text:'中'.repeat(400),source:'user'})):[],
 }]));
 const host=captureHostContext(steps,information,'step-1',false);
 const scope={sessionId:'synthetic',revision:1,hash:'0'.repeat(64),content:{work:{steps:Object.fromEntries(
  steps.map(s=>[s.id,{information:information[s.id]!.values,notes:information[s.id]!.notes}]))}}};
 return {host,scope,information};
}
it('measures final B2 checklist/text with a declared synthetic material distribution',()=>{
 const rows=[];
 // Skill prose is private; use the prior H1 16 KB fixed-system baseline PLUS final B2 rules and tool contract.
 const instructions='S'.repeat(16000)+'\n'+agentTurnInstructions();
 for(const inputBytes of [64000,90000])for(const inputChars of [100,1000,8000])for(const fieldChars of [0,100,400]){
  const {host,scope,information}=material(fieldChars);
  const current=[{role:'user',content:runtimeScopeInput('u'.repeat(inputChars),scope,host)}];
  const options={instructions,inputBytes,historyItems:100,toolBytes:groundedCardToolBytes()+150,
   historySelection:frozen,revisions:history.map((_,i)=>i+1)};
  const selected=selectBlockHistory(history,current,options).slice(0,-1);
  const legacy=selectRuntimeHistory(history,current,options).slice(0,-1);
  rows.push({inputBytes,inputChars,fieldChars,currentBytes:currentInputBytes(current),
   fallback:currentInputBytes(current)>frozen.currentReserveBytes,oldItems:legacy.length,newItems:selected.length,
   oldBytes:bytes(legacy),newBytes:bytes(selected)});
  expect(captureOrganizerInput(host,information,{},'u'.repeat(inputChars)).length).toBeLessThanOrEqual(24000);
  expect(selected.length).toBeGreaterThanOrEqual(8);
 }
 const report={systemBytes:Buffer.byteLength(instructions),reserve:frozen.currentReserveBytes,rows,
  fallbackSamples:rows.filter(r=>r.fallback).length,totalSamples:rows.length};
 expect(report).toMatchSnapshot();console.info('B2_CAPACITY_REPORT '+JSON.stringify(report));
});
it('full fields and future note maximum remain bounded; oversize organizer fails before billing',()=>{
 const {host,scope,information}=material(400,true);
 expect(bytes(scope)).toBeLessThan(262144);
 expect(bytes(host)).toBeLessThanOrEqual(16000);
 // B3 notes are not enabled by B2; this tests the declared future boundary conservatively.
 expect(()=>captureOrganizerInput(host,information,{},'u'.repeat(8000))).toThrow('OPC_CAPTURE_INPUT_LIMIT');
});
