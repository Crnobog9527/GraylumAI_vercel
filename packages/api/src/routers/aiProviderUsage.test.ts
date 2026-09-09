/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi,afterEach} from 'vitest';
import {callClaudeViaOpenRouter} from './ai';
afterEach(()=>vi.unstubAllGlobals());
it.each([undefined,{}, {prompt_tokens:-1,completion_tokens:2},{prompt_tokens:1,completion_tokens:2,total_tokens:4}])('rejects unmetered JSON response %j',async usage=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'answer'},finish_reason:'stop'}],usage})));vi.stubGlobal('fetch',fetch);
 await expect(callClaudeViaOpenRouter({model:'qwen/qwen3.8-27b',messages:[],apiKey:'sk-or-test',apiEndpoint:'https://openrouter.ai/api/v1'})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves native totals and cache/reasoning evidence in nonstream responses',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:50},completion_tokens_details:{reasoning_tokens:20}}}))));
 const result=await callClaudeViaOpenRouter({model:'openai/gpt-5.6-luna',messages:[],apiKey:'sk-or-test',apiEndpoint:'https://openrouter.ai/api/v1'});
 expect(result.usage).toEqual({inputTokens:100,outputTokens:30,cacheReadTokens:0,cacheCreationTokens:0});expect(result.usageEvidence).toMatchObject({cachedTokens:50,reasoningTokens:20});
});
