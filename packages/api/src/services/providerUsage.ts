import { geminiSearchCollector, type SearchBillingUnit } from './searchEvidence';
export { nativeSearchCapability, publicSearchEvidence, type SearchEvidence } from './searchEvidence';
import {openRouterSearchCollector} from './openRouterSearch';
export {openRouterSearchCapability,openRouterSearchParameters} from './openRouterSearch';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money=z.number().finite().nonnegative();
const usageSchema = z.object({
 prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens.optional(),
 tool_use_prompt_tokens: tokens.optional(),
 prompt_tokens_details: z.object({cached_tokens:tokens.optional(),cache_write_tokens:tokens.optional()}).nullish(),
 completion_tokens_details: z.object({reasoning_tokens:tokens.nullish()}).nullish(),
 cost:money.nullish(),is_byok:z.boolean().optional(),
 cost_details:z.object({upstream_inference_cost:money.nullish(),upstream_inference_prompt_cost:money.nullish(),upstream_inference_completions_cost:money.nullish(),server_tool_cost:money.nullish()}).nullish(),
}).superRefine((v,ctx) => {
 if (!Number.isSafeInteger(v.prompt_tokens+v.completion_tokens) || (v.total_tokens !== undefined && v.total_tokens !== v.prompt_tokens+v.completion_tokens) || (v.prompt_tokens_details?.cached_tokens??0)>v.prompt_tokens || (v.prompt_tokens_details?.cache_write_tokens??0)>v.prompt_tokens || (v.completion_tokens_details?.reasoning_tokens??0)>v.completion_tokens) ctx.addIssue({code:'custom',message:'Inconsistent provider usage'});
});
export function parseProviderUsage(value: unknown) {
 const parsed=usageSchema.safeParse(value);
 if(!parsed.success) throw new Error('PROVIDER_USAGE_UNAVAILABLE');
 const v=parsed.data;
 return {
  // OpenAI-compatible input/output totals already INCLUDE cached/reasoning
  // subsets. Do not add these subsets again or tokenize visible output instead.
  usage:{inputTokens:v.prompt_tokens,outputTokens:v.completion_tokens,cacheReadTokens:0,cacheCreationTokens:0},
  evidence:{source:'provider_usage' as const,promptTokens:v.prompt_tokens,completionTokens:v.completion_tokens,totalTokens:v.prompt_tokens+v.completion_tokens,toolUsePromptTokens:v.tool_use_prompt_tokens,cachedTokens:v.prompt_tokens_details?.cached_tokens,cacheWriteTokens:v.prompt_tokens_details?.cache_write_tokens,reasoningTokens:v.completion_tokens_details?.reasoning_tokens,
   // Reported account spend is evidence, not an extra addition to site pricing.
   // Neither server_tool_cost nor total minus inference proves a search charge.
   openRouterCost:v.cost==null?undefined:{totalUsd:v.cost,upstreamInferenceUsd:v.cost_details?.upstream_inference_cost??null,upstreamPromptUsd:v.cost_details?.upstream_inference_prompt_cost??null,upstreamCompletionUsd:v.cost_details?.upstream_inference_completions_cost??null,serverToolUsd:v.cost_details?.server_tool_cost??null,isByok:v.is_byok??null,searchUsd:null}},
 };
}

// Require both authoritative usage and a completed SSE stream. EOF without
// [DONE], malformed data or provider errors must never become estimated success.
export async function readOpenAIUsageStream(body: ReadableStream<Uint8Array>, onChunk?:()=>void, onContent?:(content:string)=>void, openRouter?:{searchEnabled:boolean}) {
 const search=openRouter?openRouterSearchCollector(openRouter.searchEnabled):undefined;
 let responseId:string|undefined;
 let finishReason:string|undefined;
 const reader=body.getReader(), decoder=new TextDecoder();
 let buffer='', content='', done=false;
 let accounting:ReturnType<typeof parseProviderUsage>|undefined;
 const line=(value:string)=>{
  if(!value.startsWith('data:'))return;
  const data=value.slice(5).trim();
  if(!data)return;
  if(data==='[DONE]'){done=true;return;}
  let event:any;
  try{event=JSON.parse(data);}catch{throw new Error('PROVIDER_STREAM_INVALID');}
  if(event.error)throw new Error('PROVIDER_STREAM_FAILED');
  if(openRouter){
   if(event.id!==undefined){if(typeof event.id!=='string'||!event.id||(responseId&&responseId!==event.id))throw new Error('PROVIDER_RESPONSE_IDENTITY_CONFLICT');responseId=event.id;}
   if(event.choices?.length>1||event.choices?.some((c:any)=>c.index!==undefined&&c.index!==0))throw new Error('PROVIDER_CANDIDATE_INVALID');
   if(event.choices?.[0]?.finish_reason!=null){
    if(typeof event.choices[0].finish_reason!=='string')throw new Error('PROVIDER_STREAM_INVALID');
    finishReason=event.choices[0].finish_reason;
   }
   search!.observeAnnotations(event.choices?.[0]?.delta?.annotations);
   search!.observeAnnotations(event.choices?.[0]?.message?.annotations);
   if(event.usage!==undefined&&event.usage!==null)search!.observeUsage(event.usage);
  }
  // A usage snapshot cannot account for subsequent output (including reasoning/tools).
  if(event.choices?.some((choice:any)=>choice.delta && Object.entries(choice.delta).some(([key,value])=>(!openRouter||!['annotations','role'].includes(key))&&value!==null && value!==undefined && value!=='')))accounting=undefined;
  const delta=event.choices?.[0]?.delta?.content;
  if(typeof delta==='string'){content+=delta;onContent?.(content);}
  if(openRouter&&event.choices?.some((choice:any)=>choice.error!=null||choice.finish_reason==='error'))throw new Error('PROVIDER_STREAM_FAILED');
  if(event.usage!==undefined && event.usage!==null)accounting=parseProviderUsage(event.usage);
 };
 try{
  while(!done){
   const next=await reader.read();
   if(next.done){buffer+=decoder.decode();if(buffer)line(buffer);break;}
   onChunk?.();buffer+=decoder.decode(next.value,{stream:true});
   let end:number;
   while((end=buffer.indexOf('\n'))>=0){const current=buffer.slice(0,end);buffer=buffer.slice(end+1);line(current);if(done)break;}
  }
 }finally{await reader.cancel();}
 if(!done || !accounting)throw new Error('PROVIDER_USAGE_UNAVAILABLE');
 if(openRouter&&(finishReason==='tool_calls'||finishReason==='function_call'))throw new Error('PROVIDER_TOOL_EXECUTION_INCOMPLETE');
 if(openRouter?.searchEnabled&&(!responseId||!accounting.evidence.openRouterCost))throw new Error('SEARCH_EVIDENCE_UNAVAILABLE');
 return {content,...accounting,evidence:{...accounting.evidence,...(responseId?{providerResponseId:responseId}:{})},search:search?.finish()};
}

export async function readGeminiUsageStream(body:ReadableStream<Uint8Array>,onChunk?:()=>void, onContent?:(content:string)=>void, searchUnit?:SearchBillingUnit) {
 const search=searchUnit?geminiSearchCollector(searchUnit):undefined;
 let responseId:string|undefined;
 const reader=body.getReader(),decoder=new TextDecoder();
 let buffer='',content='',finished=false;
 let accounting:ReturnType<typeof parseProviderUsage>|undefined;
 const line=(value:string)=>{
  if(!value.startsWith('data:'))return;
  const data=value.slice(5).trim();if(!data)return;
  const event=JSON.parse(data);
  if(event.error)throw new Error('PROVIDER_STREAM_FAILED');
  if(event.responseId){if(responseId&&responseId!==event.responseId)throw new Error('PROVIDER_RESPONSE_IDENTITY_CONFLICT');responseId=event.responseId;}
  if(event.candidates?.length>1||event.candidates?.some((c:any)=>c.index!==undefined&&c.index!==0))throw new Error('PROVIDER_CANDIDATE_INVALID');
  const candidate=event.candidates?.[0];
  if(search && candidate?.groundingMetadata!==undefined)search.observe(candidate.groundingMetadata);
  if(event.candidates?.some((value:any)=>value.content?.parts?.length))accounting=undefined;
  content+=(candidate?.content?.parts??[]).filter((p:{thought?:boolean})=>!p.thought).map((p:{text?:string})=>p.text??'').join('');
  onContent?.(content);
  if(candidate?.finishReason)finished=true;
  if(event.usageMetadata){
   const v=event.usageMetadata;
   const toolInput=tokens.parse(v.toolUsePromptTokenCount??0);
   const input=tokens.parse(v.promptTokenCount)+toolInput;
   const output=tokens.parse(v.candidatesTokenCount)+tokens.parse(v.thoughtsTokenCount??0);
   accounting=parseProviderUsage({prompt_tokens:input,tool_use_prompt_tokens:toolInput,completion_tokens:output,total_tokens:v.totalTokenCount,prompt_tokens_details:{cached_tokens:v.cachedContentTokenCount},completion_tokens_details:{reasoning_tokens:v.thoughtsTokenCount}});
  }
 };
 try{
  for(;;){const next=await reader.read();if(next.done){buffer+=decoder.decode();if(buffer)line(buffer);break;}
   onChunk?.();buffer+=decoder.decode(next.value,{stream:true});let end:number;
   while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end));buffer=buffer.slice(end+1);}
  }
 }finally{await reader.cancel();}
 if(!finished||!accounting)throw new Error('PROVIDER_USAGE_UNAVAILABLE');
 return {content,...accounting,search:search?.finish()};
}
