/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {readCaptureOutput} from './conversationCapture';
const fields={first:{schema:[{id:'goal'}]},later:{schema:[{id:'goal'}]}};
const patch={stepId:'first',fieldId:'goal',value:'  preserved  ',status:'provisional',nature:'fact',basis:'user_statement'};
const raw=(patches:unknown[])=>JSON.stringify({inputKind:'answer',patches,notes:[]});
it('keeps cross-step identity and original values but rejects invalid entries without rejecting valid siblings',()=>{
 const result=readCaptureOutput(raw([patch,{...patch,stepId:'later'},{...patch,status:'confirmed'},
  {...patch,stepId:'unknown'},{...patch,value:'😀'.repeat(400)},{...patch,value:'😀'.repeat(401)}]),fields)!;
 expect(result.discarded).toEqual([3,4,6]);expect(result.patches.map(p=>p.stepId)).toEqual(['first','later','first']);
 expect(result.patches[0]!.value).toBe('  preserved  ');
});
it.each(['[]','null','{}','```json\n{}\n```',raw(Array(13).fill(patch)),
 JSON.stringify({inputKind:'answer',patches:[],notes:null}),
 JSON.stringify({inputKind:['answer'],patches:[],notes:[]})])('rejects malformed B1 output %s',value=>{
 expect(readCaptureOutput(value,fields)).toBeNull();
});
