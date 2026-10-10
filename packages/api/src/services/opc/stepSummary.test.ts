/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {STEP_SUMMARY_INPUT,stepSummaryNoticeSchema} from '../../shared/opcStepSummary';
import {stepConfirmation} from '../../shared/opcStepConfirmation';
import {readStepSummaryRequest,buildStepSummaryNotice} from './stepSummary';
import type {CaptureState} from './captureContext';
const request={input:STEP_SUMMARY_INPUT,purpose:'mentor'};
it('requires the explicit host action and rejects mixed request meanings',()=>{
 expect(readStepSummaryRequest(request)).toBe(true);
 expect(readStepSummaryRequest({...request,input:'这一步先到这里'})).toBe(false);
 for(const change of [{purpose:'step'},{purpose:'plan'},{answerSource:{}},{questionId:'goal'},
  {input:'HOST_STEP_SUMMARY:v2'},{input:'HOST_STEP_SUMMARY:v1 extra'}])
  expect(()=>readStepSummaryRequest({...request,...change})).toThrow('OPC_STEP_SUMMARY_INVALID');
});
it('lists only this step’s missing required content without changing fields or confirming',()=>{
 const state:CaptureState={schema:[{id:'known',required:true},{id:'missing',required:true},
  {id:'deferred',required:true},{id:'emptyStatus',required:true},{id:'optional',required:false}],
  values:{known:{value:'A proposal',status:'provisional'},deferred:{value:'Unknown until next month',status:'deferred'},
   emptyStatus:{value:' ',status:'confirmed'}}};
 const before=structuredClone(state),confirmation=stepConfirmation(state,false);
 const notice=buildStepSummaryNotice(state);
 expect(notice).toEqual({kind:'step_summary',missingRequiredFieldIds:['missing','emptyStatus']});
 expect(state).toEqual(before);expect(stepConfirmation(state,false)).toEqual(confirmation);
 expect(confirmation.stepConfirmed).toBe(false);expect(confirmation.requiredComplete).toBe(false);
 expect(stepSummaryNoticeSchema.safeParse({...notice,confirmed:true}).success).toBe(false);
});
it('complete or deferred content still needs the existing explicit confirmation',()=>{
 const state:CaptureState={schema:[{id:'goal',required:true}],values:{goal:{value:'Not decided yet',status:'deferred'}}};
 expect(buildStepSummaryNotice(state).missingRequiredFieldIds).toEqual([]);
 expect(stepConfirmation(state,false)).toMatchObject({requiredComplete:true,stepReady:true,stepConfirmed:false});
});
