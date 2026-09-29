/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {reasoningPolicy,approvedReasoningEfforts,frozenReasoningFields,matchesFrozenReasoning} from './reasoningPolicy';
import {REASONING_EFFORTS,MAX_REASONING_BUDGET} from '../../shared/modelReasoning';
it.each(REASONING_EFFORTS)('accepts documented effort %s structurally, without model names',effort=>{
 expect(approvedReasoningEfforts.has(effort)).toBe(true);
 expect(reasoningPolicy.parse({effort})).toEqual({effort});
 expect(frozenReasoningFields({effort})).toEqual({reasoning_effort:effort});
 expect(frozenReasoningFields({parameter:'reasoning',value:{effort}})).toEqual({reasoning:{effort}});
});
it.each([{enabled:false},{effort:'max'},{max_tokens:1},{max_tokens:MAX_REASONING_BUDGET}])('accepts strict object %#',value=>{
 const policy=reasoningPolicy.parse({parameter:'reasoning',value});
 expect(matchesFrozenReasoning({reasoning:structuredClone(value)},policy)).toBe(true);
 expect(matchesFrozenReasoning({reasoning:{...value,exclude:true}},policy)).toBe(false);
 expect(matchesFrozenReasoning({reasoning:value,reasoning_effort:'none'},policy)).toBe(false);
});
it.each([{enabled:true},{exclude:true},{effort:'unknown'},{effort:'none',max_tokens:1},{max_tokens:0},{max_tokens:1.5},{max_tokens:MAX_REASONING_BUDGET+1},null,[],{}])('rejects malformed object %#',value=>{
 expect(reasoningPolicy.safeParse({parameter:'reasoning',value}).success).toBe(false);
});
it('represents provider default explicitly without sending either field',()=>{
 expect(frozenReasoningFields({parameter:'none'})).toEqual({});
 expect(matchesFrozenReasoning({}, {parameter:'none'})).toBe(true);
 for(const value of [{reasoning:null},{reasoning_effort:null},{reasoning:{enabled:false}}])
  expect(matchesFrozenReasoning(value,{parameter:'none'})).toBe(false);
 expect(reasoningPolicy.safeParse({parameter:'none',value:{enabled:false}}).success).toBe(false);
});
