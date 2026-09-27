/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {reasoningFor,reasoningPolicy,approvedReasoningEfforts} from './reasoningPolicy';
it('maps the latency-sensitive target through the verified model table only',()=>{
 expect(reasoningFor('latency-sensitive','qwen/qwen3.8-27b')).toEqual({effort:'none'});
 for(const model of ['qwen/qwen3.8-27b:free','qwen/qwen3.8-flash','test/model','constructor','__proto__','toString',''])
  expect(()=>reasoningFor('latency-sensitive',model)).toThrow('RUNTIME_REASONING_POLICY_UNVERIFIED');
 expect([...approvedReasoningEfforts]).toEqual(['none']);
});
it('returns a detached copy and accepts only the exact effort structure',()=>{
 const first=reasoningFor('latency-sensitive','qwen/qwen3.8-27b');first.effort='xhigh';
 expect(reasoningFor('latency-sensitive','qwen/qwen3.8-27b')).toEqual({effort:'none'});
 for(const value of [{effort:'max'},{effort:'none',max_tokens:1},{effort:'none',exclude:true},{enabled:false},{effort:null},'none'])
  expect(reasoningPolicy.safeParse(value).success).toBe(false);
});
