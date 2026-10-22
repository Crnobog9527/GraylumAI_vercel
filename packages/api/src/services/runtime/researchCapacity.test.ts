/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {expect,it} from 'vitest';
import {researchCapacity} from './researchCapacity';
import {selectRuntimeHistory} from './context';
it('numeric accounting agrees with admission at the exact escaped UTF-8 boundary',()=>{
 const instructions='中 " \\ \u0001',currentInput='{"value":"中\\\\\\\""}';
 const additions={existingToolsBytes:2520,researchToolsBytes:5327,researchHostDeltaBytes:708,resultReserveBytes:24576};
 const sum=Object.values(additions).reduce((a,b)=>a+b,0);
 const measure=researchCapacity({instructions,currentInput,inputBudgetBytes:112000,...additions});
 const check=(inputBytes:number)=>selectRuntimeHistory([],[{role:'user',content:currentInput}],
  {instructions,historyItems:0,inputBytes,toolBytes:sum});
 expect(()=>check(measure.totalRequiredBytes)).not.toThrow();
 expect(()=>check(measure.totalRequiredBytes-1)).toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
 expect(researchCapacity({instructions,currentInput,inputBudgetBytes:measure.totalRequiredBytes-1,...additions}).deficitBytes).toBe(1);
 expect(measure.fixedInstructionsBytes+measure.currentInputHostBytes+measure.envelopeReserveBytes+sum).toBe(measure.totalRequiredBytes);
 expect(Object.values(measure).every(value=>Number.isSafeInteger(value)&&value>=0)).toBe(true);
 expect(JSON.stringify(measure)).not.toContain(instructions);
});
