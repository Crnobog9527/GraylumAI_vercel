/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {captureWorkflowSteps as steps} from '../__tests__/fixtures/captureWorkflow';
import {captureHostContext,captureOrganizerInput} from './captureContext';
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
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
it('full fields and future note maximum remain bounded; oversize organizer fails before billing',()=>{
 const {host,scope,information}=material(400,true);
 expect(bytes(scope)).toBeLessThan(262144);
 expect(bytes(host)).toBeLessThanOrEqual(16000);
 // B3 notes are not enabled by B2; this tests the declared future boundary conservatively.
 expect(()=>captureOrganizerInput(host,information,{},'u'.repeat(8000))).toThrow('OPC_CAPTURE_INPUT_LIMIT');
});
