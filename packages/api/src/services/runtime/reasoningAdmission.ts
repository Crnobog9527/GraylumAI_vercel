/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {checkReasoningConfig,reasoningConfig,reasoningRequestFields} from '../../shared/modelReasoning';
import {StagingAccessError} from './stagingErrors';
import {reasoningPolicy,type ReasoningPolicy} from './reasoningPolicy';

/** Admission only. Execution must never consult mutable administrator settings. */
export function admitReasoning(
 row:{config?:unknown;model_id:string},purpose:'interactive'|'organize',
 providerSlug:string,maxOutputTokens:number,
):ReasoningPolicy{
 const raw=row.config&&typeof row.config==='object'&&!Array.isArray(row.config)
  ?(row.config as Record<string,unknown>).reasoning:undefined;
 if(raw==null){
  if(purpose==='organize')return {parameter:'none'};
  throw new StagingAccessError('RUNTIME_REASONING_NOT_CONFIGURED');
 }
 const parsed=reasoningConfig.safeParse(raw);
 if(!parsed.success)throw new StagingAccessError('RUNTIME_REASONING_CONFIG_INVALID');
 const config=parsed.data,setting=config.purposes[purpose];
 if(!setting){
  if(purpose==='organize')return {parameter:'none'};
  throw new StagingAccessError('RUNTIME_REASONING_NOT_CONFIGURED');
 }
 if(config.route!==providerSlug)throw new StagingAccessError('RUNTIME_REASONING_ROUTE_MISMATCH');
 // Only the selected purpose is active here; review/writing remain storage-only.
 // The actual output budget is no larger than the model, quote or organizer limit.
 const issues=checkReasoningConfig({...config,purposes:{[purpose]:setting}},
  {modelId:row.model_id,maxTokens:maxOutputTokens});
 if(issues.length)throw new StagingAccessError('RUNTIME_REASONING_CONFIG_INVALID');
 const fields=reasoningRequestFields(setting);
 if('reasoning_effort' in fields)return reasoningPolicy.parse({effort:fields.reasoning_effort});
 if('reasoning' in fields)return reasoningPolicy.parse({parameter:'reasoning',value:fields.reasoning});
 return {parameter:'none'};
}
