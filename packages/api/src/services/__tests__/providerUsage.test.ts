/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {parseProviderUsage,readOpenAIUsageStream} from '../providerUsage';
const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:70},completion_tokens_details:{reasoning_tokens:15}};
it('keeps native totals, records cached/reasoning subsets without adding them twice',()=>{
 const r=parseProviderUsage(usage);expect(r.usage).toEqual({inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheCreationTokens:0});expect(r.evidence).toMatchObject({cachedTokens:70,reasoningTokens:15,totalTokens:120});
});
it('accepts authoritative zero usage',()=>expect(parseProviderUsage({prompt_tokens:0,completion_tokens:0,total_tokens:0}).usage.outputTokens).toBe(0));
it.each([undefined,null,{}, {prompt_tokens:1}, {prompt_tokens:'1',completion_tokens:2},{prompt_tokens:-1,completion_tokens:2},{prompt_tokens:1.5,completion_tokens:2},{prompt_tokens:NaN,completion_tokens:2},{prompt_tokens:Infinity,completion_tokens:2},{...usage,total_tokens:121},{...usage,completion_tokens_details:{reasoning_tokens:21}},{...usage,prompt_tokens_details:{cached_tokens:101}},{prompt_tokens:Number.MAX_SAFE_INTEGER,completion_tokens:1}])('rejects missing/invalid native usage %j',raw=>expect(()=>parseProviderUsage(raw)).toThrow('PROVIDER_USAGE_UNAVAILABLE'));
function bytes(value:string){const encoded=new TextEncoder().encode(value);return new ReadableStream<Uint8Array>({start(c){for(let i=0;i<encoded.length;i+=3)c.enqueue(encoded.slice(i,i+3));c.close();}});}
it('reads fragmented UTF-8, CRLF, final usage without choices and DONE without trailing newline',async()=>{
 const r=await readOpenAIUsageStream(bytes(': keepalive\r\ndata: {"choices":[{"delta":{"content":"中文"}}],"usage":null}\r\n\r\ndata: '+JSON.stringify({usage})+'\r\n\r\ndata: [DONE]'));expect(r.content).toBe('中文');expect(r.usage.inputTokens).toBe(100);
});
it.each(['data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n', 'data: '+JSON.stringify({usage})+'\n', 'data: '+JSON.stringify({usage})+'\ndata: {"error":{"message":"failed"}}\ndata: [DONE]\n', 'data: {bad}\ndata: [DONE]\n'])('rejects missing usage, interrupted/error/malformed streams',async text=>{await expect(readOpenAIUsageStream(bytes(text))).rejects.toThrow();});

import {readGeminiUsageStream} from '../providerUsage';
it('counts Gemini thoughts as output, without exposing thought text',async()=>{
 const raw={candidates:[{finishReason:'STOP',content:{parts:[{text:'private thought',thought:true},{text:'answer'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130}};
 const result=await readGeminiUsageStream(bytes('data: '+JSON.stringify(raw)));expect(result.content).toBe('answer');expect(result.usage.outputTokens).toBe(30);
});
it('rejects invalid Gemini usage after an earlier valid frame',async()=>{
 const good={candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}};
 await expect(readGeminiUsageStream(bytes('data: '+JSON.stringify(good)+'\ndata: {"usageMetadata":{"promptTokenCount":-1,"candidatesTokenCount":1}}'))).rejects.toThrow();
});

it.each([{content:'later output'},{reasoning:'later thought'},{tool_calls:[{id:'call-1'}]}])('requires fresh usage after subsequent OpenAI output %j',async delta=>{
 const prefix='data: '+JSON.stringify({choices:[],usage})+'\ndata: '+JSON.stringify({choices:[{delta}],usage:null})+'\n';
 await expect(readOpenAIUsageStream(bytes(prefix+'data: [DONE]'))).rejects.toThrow('PROVIDER_USAGE_UNAVAILABLE');
 await expect(readOpenAIUsageStream(bytes(prefix+'data: '+JSON.stringify({usage})+'\ndata: [DONE]'))).resolves.toMatchObject({usage:{inputTokens:100,outputTokens:20}});
});
it.each([false,true])('requires fresh Gemini usage after subsequent content or thought (%s)',async thought=>{
 const metadata={promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120};
 const prefix='data: '+JSON.stringify({usageMetadata:metadata})+'\ndata: '+JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'later',thought}]}}]})+'\n';
 await expect(readGeminiUsageStream(bytes(prefix))).rejects.toThrow('PROVIDER_USAGE_UNAVAILABLE');
 await expect(readGeminiUsageStream(bytes(prefix+'data: '+JSON.stringify({usageMetadata:metadata})))).resolves.toMatchObject({usage:{inputTokens:100,outputTokens:20}});
});
