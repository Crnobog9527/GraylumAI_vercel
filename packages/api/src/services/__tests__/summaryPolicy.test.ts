/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { summaryPolicy, assertSeparateSummaryModel } from '../artifacts/summaryPolicy';
const primary = '11111111-1111-4111-8111-111111111111';
const summary = '22222222-2222-4222-8222-222222222222';
describe('separate summary model policy', () => {
  it('requires an explicit independent model with bounded output', () => {
    expect(summaryPolicy({ v3_summary_model_id: summary }, primary)).toEqual({ modelId: summary, maxTokens: 2048 });
    expect(summaryPolicy({ v3_summary_model_id: summary, v3_summary_max_tokens: '512' }, primary).maxTokens).toBe(512);
  });
  it.each([undefined, '', 'unknown', null])('never falls back to primary for missing or invalid model %s', value => {
    expect(() => summaryPolicy({ v3_summary_model_id: value }, primary)).toThrow('SUMMARY_MODEL_NOT_CONFIGURED');
  });
  it('rejects primary record reuse and duplicate provider-model records', () => {
    expect(() => summaryPolicy({ v3_summary_model_id: primary }, primary)).toThrow('SUMMARY_MODEL_MUST_DIFFER');
    expect(() => assertSeparateSummaryModel('vendor/primary', ' VENDOR/PRIMARY ')).toThrow('SUMMARY_MODEL_MUST_DIFFER');
    expect(() => assertSeparateSummaryModel('vendor/primary', 'vendor/summary')).not.toThrow();
  });
  it.each([0, 127, 4097, 1.5, '', 'unbounded'])('rejects invalid output cap %s', value => {
    expect(() => summaryPolicy({ v3_summary_model_id: summary, v3_summary_max_tokens: value }, primary)).toThrow('SUMMARY_OUTPUT_LIMIT_INVALID');
  });
});


describe('admin and runtime use one OpenRouter configuration policy', () => {
  const row={id:summary,name:'Configured secondary',model_id:'openai/gpt-5.6-luna',provider:'openai',is_active:'true',max_tokens:4096,input_limit:800000,api_key:'SECRET_CANARY',api_endpoint:'',token_counting_supported:'false',tokenizer_family:'openai'};
  it.each(['qwen/qwen3.8-27b','openai/gpt-5.6-luna','anthropic/claude-opus-4.5'])('accepts configured %s using derived usage and the default endpoint without rewriting storage',async model_id=>{
    const {summaryModelOption,workbenchModelSchema,providerInputReservation}=await import('../artifacts/modelPolicy');
    const input={...row,model_id},before=JSON.stringify(input),option=summaryModelOption(input),model=workbenchModelSchema.parse(input);
    expect(option).toEqual({id:summary,name:row.name,model_id,available:true,reason:null});
    expect(JSON.stringify(option)).not.toContain('SECRET_CANARY');
    expect(JSON.stringify(input)).toBe(before);
    expect(model.api_endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(model.token_counting_supported).toBe('true');
    const messages=[{content:'中文 🐈 <|endoftext|>'}];
    expect(providerInputReservation(model,messages,2048)).toBe(128000-2048);
    expect(providerInputReservation(model,messages,2048)).toBeLessThan(128000);
  });
  it.each([{api_key:''},{model_id:''},{model_id:'openrouter/auto'},{model_id:'@preset/test'},{is_active:'false'},{api_endpoint:'https://example.test'},{input_limit:0},{max_tokens:0}])('gives an actionable reason for unavailable configuration: %j',async patch=>{
    const {summaryModelOption}=await import('../artifacts/modelPolicy');
    const option=summaryModelOption({...row,...patch});
    expect(option.available).toBe(false);expect(option.reason).toBeTruthy();expect(JSON.stringify(option)).not.toContain('SECRET_CANARY');
  });
  it('bounds the task independently of advertised context and rejects oversize without truncation',async()=>{
    const {workbenchModelSchema,providerInputReservation}=await import('../artifacts/modelPolicy');
    const model=workbenchModelSchema.parse(row);
    expect(()=>providerInputReservation(model,[{content:'猫'.repeat(50000)}],2048)).toThrow('GENERATION_CAPACITY');
    expect(()=>providerInputReservation({...model,input_limit:8000},[{content:'a'}],2048)).toThrow('GENERATION_CAPACITY');
  });
});
