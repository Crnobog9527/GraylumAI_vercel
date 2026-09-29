/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {MAX_REASONING_BUDGET,REASONING_EFFORTS} from '../../shared/modelReasoning';

/** Structural wire validation only. Admission validates catalog/route capability. */
export const approvedReasoningEfforts:ReadonlySet<string>=new Set(REASONING_EFFORTS);
export const reasoningObject=z.union([
 z.object({enabled:z.literal(false)}).strict(),
 z.object({effort:z.enum(REASONING_EFFORTS)}).strict(),
 z.object({max_tokens:z.number().int().positive().max(MAX_REASONING_BUDGET)}).strict(),
]);
/** Keep the legacy effort shape: SDK serialization and stored v4 hashes depend on it. */
export const reasoningPolicy=z.union([
 z.object({effort:z.enum(REASONING_EFFORTS)}).strict(),
 z.object({parameter:z.literal('reasoning'),value:reasoningObject}).strict(),
 z.object({parameter:z.literal('none')}).strict(),
]);
export type ReasoningPolicy=z.infer<typeof reasoningPolicy>;

export function frozenReasoningFields(policy?:ReasoningPolicy){
 if(!policy)return {};
 const parsed=reasoningPolicy.parse(policy);
 if('effort' in parsed)return {reasoning_effort:parsed.effort};
 return parsed.parameter==='reasoning'?{reasoning:parsed.value}:{};
}
/** Deep comparison also rejects extra keys, nulls and both wire forms together. */
export function matchesFrozenReasoning(body:Record<string,unknown>,policy?:ReasoningPolicy):boolean{
 const actual=Object.fromEntries(['reasoning_effort','reasoning'].filter(key=>key in body).map(key=>[key,body[key]]));
 return isDeepStrictEqual(actual,frozenReasoningFields(policy));
}
