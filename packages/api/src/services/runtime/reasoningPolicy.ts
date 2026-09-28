/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';

/** Graylum states the product target; each model maps it to provider
 * parameters verified for that model. Admission freezes the mapped value into
 * the execution context, so replay never consults this table again.
 * Values are the OpenRouter Chat Completions `reasoning_effort` enum, emitted
 * through the SDK's own modelSettings.reasoning.effort mapping.
 * https://openrouter.ai/docs/api/reference/parameters
 */
export const reasoningPolicy=z.object({effort:z.enum(['none','minimal','low','medium','high','xhigh'])}).strict();
export type ReasoningPolicy=z.infer<typeof reasoningPolicy>;
export type RequestTarget='latency-sensitive';

// Add a model only after checking its OpenRouter reasoning metadata and a
// compatibility run. An unlisted model fails closed for a listed target.
const modelPolicies:Readonly<Record<string,Readonly<Partial<Record<RequestTarget,ReasoningPolicy>>>>>=Object.freeze({
 // OpenRouter model metadata (2026-09-27): reasoning mandatory=false,
 // default_enabled=true, default_effort=xhigh. Omitting the field kept xhigh
 // thinking, which produced no public text within the 120s response bound.
 'qwen/qwen3.8-27b':Object.freeze({'latency-sensitive':Object.freeze({effort:'none' as const})}),
 // Owner 2026-09-28/29: mentor model. AC-0 probe on the DeepInfra route with
 // reasoning_effort "none": 84 provider responses, each reporting 0 reasoning tokens.
 'deepseek/deepseek-v4.1-flash':Object.freeze({'latency-sensitive':Object.freeze({effort:'none' as const})}),
});

export function reasoningFor(target:RequestTarget,model:string):ReasoningPolicy{
 const policy=Object.hasOwn(modelPolicies,model)?modelPolicies[model]?.[target]:undefined;
 if(!policy)throw new Error('RUNTIME_REASONING_POLICY_UNVERIFIED');
 return reasoningPolicy.parse(policy);
}

/** Provider adapter allowlist: only values some verified policy can produce. */
export const approvedReasoningEfforts:ReadonlySet<string>=new Set(
 Object.values(modelPolicies).flatMap(targets=>Object.values(targets).map(policy=>policy!.effort)));
