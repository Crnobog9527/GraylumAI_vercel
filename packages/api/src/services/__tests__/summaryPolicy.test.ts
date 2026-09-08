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


describe('admin summary model eligibility', () => {
  const row={id:summary,name:'Configured secondary',model_id:'openai/gpt-4o-mini-2024-07-18',is_active:'true',max_tokens:2048,input_limit:128000,api_key:'SECRET_CANARY',api_endpoint:'https://openrouter.ai/api/v1',token_counting_supported:'true',tokenizer_family:'o200k_base'};
  it('returns only public display fields and the same runtime eligibility',async()=>{
    const {summaryModelOption}=await import('../artifacts/modelPolicy');
    expect(summaryModelOption(row)).toEqual({id:summary,name:row.name,model_id:row.model_id,available:true});
    expect(JSON.stringify(summaryModelOption(row))).not.toContain('SECRET_CANARY');
  });
  it.each([{api_key:''},{model_id:'not-adapted/model'},{is_active:'false'},{api_endpoint:'https://example.test'},{tokenizer_family:'wrong'}])('marks incomplete or unsupported configuration unavailable: %j',async patch=>{
    const {summaryModelOption}=await import('../artifacts/modelPolicy');
    expect(summaryModelOption({...row,...patch}).available).toBe(false);
  });
});


describe('Qwen input reservation',()=>{
 const row={id:summary,model_id:'qwen/qwen3.8-flash' as const,is_active:'true' as const,max_tokens:2048,input_limit:128000,api_key:'SYNTHETIC',api_endpoint:'https://openrouter.ai/api/v1' as const,token_counting_supported:'true' as const,tokenizer_family:'openai' as const};
 it('admits the real model name with admin provider-usage metadata and reserves its full input capacity',async()=>{
  const {workbenchModelSchema,qwenInputReservation}=await import('../artifacts/modelPolicy');
  expect(workbenchModelSchema.safeParse(row).success).toBe(true);
  expect(qwenInputReservation(row,[{content:'中文 🐈 <|endoftext|>'}],2048)).toBe(125952);
 });
 it('rejects a prompt beyond the byte envelope without truncation or paid dispatch',async()=>{
  const {qwenInputReservation}=await import('../artifacts/modelPolicy');
  expect(()=>qwenInputReservation(row,[{content:'猫'.repeat(50000)}],2048)).toThrow('GENERATION_CAPACITY');
 });
});
