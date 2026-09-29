/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {admitReasoning} from './reasoningAdmission';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {stagingProcedureError,StagingAccessError} from './stagingErrors';
import type {PurposeSetting} from '../../shared/modelReasoning';
const model='synthetic/new-model';
it.each([
 [{mode:'off',wire:'reasoning_effort'},{effort:'none'}],
 [{mode:'off',wire:'reasoning'},{parameter:'reasoning',value:{enabled:false}}],
 [{mode:'effort',wire:'reasoning_effort',effort:'max'},{effort:'max'}],
 [{mode:'effort',wire:'reasoning',effort:'high'},{parameter:'reasoning',value:{effort:'high'}}],
 [{mode:'budget',maxTokens:2048},{parameter:'reasoning',value:{max_tokens:2048}}],
 [{mode:'provider_default'},{parameter:'none'}],
] as const)('freezes configured setting %# with no model allowlist', (setting,expected)=>{
 expect(admitReasoning({model_id:model,config:configuredReasoning(model,setting)},'interactive','synthetic/fp8',4096)).toEqual(expected);
});
it('maps missing interactive configuration to the specified code and actionable Chinese message',()=>{
 expect(()=>admitReasoning({model_id:model},'interactive','synthetic/fp8',4096)).toThrow('RUNTIME_REASONING_NOT_CONFIGURED');
 expect(stagingProcedureError(new StagingAccessError('RUNTIME_REASONING_NOT_CONFIGURED'),'runtime.prepare')).toMatchObject({code:'PRECONDITION_FAILED',message:'请在后台为这个模型设置“交互对话”的思考方式。'});
});
it.each([undefined,{},configuredReasoning(model)])('defaults an unset organizer purpose without catalog or route requirements %#',config=>{
 expect(admitReasoning({model_id:model,config},'organize','other/route',256)).toEqual({parameter:'none'});
});
it.each(['synthetic','synthetic/fp16','other/fp8'])('rejects full route mismatch %s',route=>{
 expect(()=>admitReasoning({model_id:model,config:configuredReasoning(model)},'interactive',route,4096)).toThrow('RUNTIME_REASONING_ROUTE_MISMATCH');
});
it.each(['model','route','quote','budget'] as const)('checks the smallest output limit: %s',limit=>{
 const setting:PurposeSetting=limit==='budget'?{mode:'budget',maxTokens:3500}:{mode:'effort',wire:'reasoning',effort:'high'};
 const config=configuredReasoning(model,setting);
 if(limit==='route')config.reasoning.catalog!.endpoints[0]!.maxCompletionTokens=2048;
 expect(()=>admitReasoning({model_id:model,config},'interactive','synthetic/fp8',limit==='model'||limit==='quote'?2048:4096)).toThrow('RUNTIME_REASONING_CONFIG_INVALID');
});
it.each(['stale','tools','wire','mandatory','effort','budget','malformed'] as const)('rejects invalid configured capability %s',kind=>{
 const config=configuredReasoning(model);
 if(kind==='stale')config.reasoning.catalog!.model='old/model';
 if(kind==='tools')config.reasoning.catalog!.endpoints[0]!.supportedParameters=['reasoning_effort'];
 if(kind==='wire')config.reasoning.catalog!.endpoints[0]!.supportedParameters=['tools','reasoning'];
 if(kind==='mandatory')config.reasoning.catalog!.reasoning!.mandatory=true;
 if(kind==='effort')config.reasoning.purposes.interactive={mode:'effort',wire:'reasoning',effort:'medium'};
 if(kind==='budget'){
  config.reasoning.purposes.interactive={mode:'budget',maxTokens:1024};
  config.reasoning.catalog!.reasoning!.supportsMaxTokens=false;
 }
 if(kind==='malformed')(config.reasoning.purposes.interactive as any).extra=true;
 expect(()=>admitReasoning({model_id:model,config},'interactive','synthetic/fp8',4096)).toThrow('RUNTIME_REASONING_CONFIG_INVALID');
});
it('retains the accepted provider_default limitation and ignores inactive review/writing capability',()=>{
 const config=configuredReasoning(model,{mode:'provider_default'});
 config.reasoning.catalog!.reasoning!.mandatory=true;
 config.reasoning.catalog!.endpoints[0]!.maxCompletionTokens=256;
 config.reasoning.purposes.review={mode:'off',wire:'reasoning'};
 config.reasoning.purposes.writing={mode:'budget',maxTokens:128000};
 expect(admitReasoning({model_id:model,config},'interactive','synthetic/fp8',256)).toEqual({parameter:'none'});
});
