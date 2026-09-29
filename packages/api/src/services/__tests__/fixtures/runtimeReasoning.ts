/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {PurposeSetting,ReasoningConfig} from '../../../shared/modelReasoning';
export function configuredReasoning(model:string,setting:PurposeSetting={mode:'off',wire:'reasoning_effort'},purpose:'interactive'|'organize'='interactive'): {reasoning:ReasoningConfig}{
 return {reasoning:{route:'synthetic/fp8',catalog:{fetchedAt:'2026-09-29T00:00:00Z',model,
  reasoning:{mandatory:false,defaultEnabled:true,supportedEfforts:['low','high','max'],defaultEffort:'high',supportsMaxTokens:true},
  endpoints:[{tag:'synthetic/fp8',providerName:'Synthetic',supportedParameters:['tools','reasoning','reasoning_effort'],contextLength:32000,maxCompletionTokens:8192}]},
  purposes:{[purpose]:setting}}};
}
