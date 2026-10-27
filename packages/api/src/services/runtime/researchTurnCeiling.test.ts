/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 2026-10-27 ("把上限从 112,000 提到 150,000。多留点余量"): a turn that offers the research tools has a 150000-byte
// input ceiling. Organize stays 112000, the configured interactive budget 90000, the report 196608.
import {expect,it} from 'vitest';
import {frozenPurposeBudget,PURPOSE_INPUT_CAPS,RESEARCH_TURN_INPUT_CAP} from './purposeBudgets';
import {RESEARCH_TURN_INPUT_BYTES} from './researchAdmission';
import {researchCapacity} from './researchCapacity';

// Every research_admission_rejected row on staging (2026-10-22 .. 10-27) that carried capacity numbers, read with the
// old 112000 ceiling: totalRequiredBytes = 112000 + deficitBytes.
const REJECTED_AT_112000_DEFICITS=[4339,2713,1588,942,1325,4257,1158,472,41,1167,267];
const MARGIN=8192;

it('the research ceiling is 150000 and only the research turn gets it',()=>{
 expect(RESEARCH_TURN_INPUT_CAP).toBe(150000);
 expect(RESEARCH_TURN_INPUT_BYTES).toBe(150000);
 expect(PURPOSE_INPUT_CAPS).toEqual({interactive:90000,organize:112000,report:196608});
 const budget=(purpose:string,inputBytes:number)=>frozenPurposeBudget.safeParse({purpose,inputBytes,historyItems:0}).success;
 expect(budget('interactive',150000)).toBe(true);
 expect(budget('interactive',150001)).toBe(false);
 expect(budget('interactive',112000)).toBe(true);
 expect(budget('organize',112000)).toBe(true);
 expect(budget('organize',112001)).toBe(false);
 expect(budget('organize',150000)).toBe(false);
 expect(budget('report',196608)).toBe(true);
 expect(budget('report',196609)).toBe(false);
});

it('every real staging rejection fits the 150000 ceiling with at least 8 KB to spare',()=>{
 for(const deficit of REJECTED_AT_112000_DEFICITS){
  const total=112000+deficit;
  // researchCapacity's deficit is computed from inputBudgetBytes, so rebuild one with these totals.
  const rebuilt=researchCapacity({instructions:'',currentInput:'',inputBudgetBytes:RESEARCH_TURN_INPUT_BYTES,
   existingToolsBytes:total,researchToolsBytes:0,researchHostDeltaBytes:0,resultReserveBytes:0});
  expect(rebuilt.deficitBytes).toBe(0);
  expect(RESEARCH_TURN_INPUT_BYTES-rebuilt.totalRequiredBytes).toBeGreaterThanOrEqual(MARGIN);
 }
 expect(Math.max(...REJECTED_AT_112000_DEFICITS)+112000).toBe(116339);
});

it('an ordinary interactive turn stays at 90000: a ceiling above it needs the research block in the same context',async()=>{
 const {runtimeContext}=await import('./runtimeContext');
 const base={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',model:'fixture/m',input:'hi',instructions:'x',maxOutputTokens:100,
  maxTurns:1,historyItems:0,tools:[],sources:[],network:'deny'};
 const budget=(inputBytes:number)=>({...base,purposeBudget:{purpose:'interactive',inputBytes,historyItems:0}});
 expect(runtimeContext.safeParse(budget(90000)).success).toBe(true);
 const raised=runtimeContext.safeParse(budget(150000));
 expect(raised.success).toBe(false);
 expect(JSON.stringify(raised.error?.issues)).toContain('RUNTIME_PURPOSE_INPUT_LIMIT');
});
