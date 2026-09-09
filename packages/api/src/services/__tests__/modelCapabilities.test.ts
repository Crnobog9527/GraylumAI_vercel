/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {inferTokenCountingMetadata,withTokenCountingMetadata} from '../modelCapabilities';
it.each(['qwen/qwen3.8-27b','openai/gpt-5.6-luna','anthropic/claude-opus-4.5'])('uses the default OpenRouter endpoint for %s',modelId=>{
 for(const apiEndpoint of ['', '   ',undefined,'https://openrouter.ai/api/v1','https://openrouter.ai/api/v1/chat/completions']) expect(inferTokenCountingMetadata({provider:'openai',modelId,apiEndpoint})).toMatchObject({token_counting_supported:'true',token_counting_method:'provider_usage'});
});
it('corrects stale derived flags without changing stored endpoint, key, pricing or row',()=>{
 const row={provider:'openai',model_id:'qwen/qwen3.8-27b',api_endpoint:'',api_key:'private',input_token_cost:123,token_counting_supported:'false'};
 expect(withTokenCountingMetadata(row)).toMatchObject({...row,token_counting_supported:'true'});expect(row.token_counting_supported).toBe('false');
});
it.each(['https://openrouter.ai.evil.test/api/v1/chat/completions','https://proxy.test/chat/completions?url=openrouter.ai','http://openrouter.ai/api/v1/chat/completions'])('does not grant native usage support from a deceptive endpoint %s',apiEndpoint=>expect(inferTokenCountingMetadata({provider:'openai',modelId:'qwen/qwen3.8-27b',apiEndpoint}).token_counting_supported).toBe('false'));
