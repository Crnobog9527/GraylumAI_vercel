/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { contractHash, creditsToUnits, ResearchError, type ProviderContract, type ProviderContext, type ReviewedCapability } from './agentKey';
import { tavilySchema } from './tavilySchema';

export const TAVILY_SEARCH = 'Tavily/post_search';
const query=z.string().trim().min(1).max(200);
const input=z.object({query,search_depth:z.literal('basic'),max_results:z.number().int().min(1).max(3),auto_parameters:z.literal(false),include_answer:z.literal(false),include_raw_content:z.literal(false),include_images:z.literal(false),include_usage:z.literal(true),topic:z.literal('general')}).strict();
export const tavilyCapabilities:readonly ReviewedCapability[]=[{internalName:'tavily.webSearch',canonicalName:TAVILY_SEARCH,schemaHash:contractHash(tavilySchema),parameterKeys:Object.keys(input.shape),maxQuoteCredits:1.1}];
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const parsed=schema.safeParse(value);if(!parsed.success)throw new ResearchError('PROVIDER_CONTRACT_INVALID');return parsed.data;}
function request(context:ProviderContext){if(context.canonicalName!==TAVILY_SEARCH)throw new ResearchError('UNSUPPORTED_CAPABILITY');return parse(input,context.params);}
const url=z.string().max(4096).refine(value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});
const result=z.object({id:z.string().min(1).max(256),title:z.string().min(1).max(2000),url,content:z.string().max(20000),score:z.number().finite().min(0).max(1),raw_content:z.null()}).strict();

/** No environment activation: the host must supply authorization, budget and durable store. */
export const tavilyContract:ProviderContract={
 discovery(value){const v=parse(z.object({tools:z.array(z.object({name:z.string().min(1).max(256),disabled:z.boolean().optional(),unavailable:z.boolean().optional()})).max(100)}),value);return {names:v.tools.filter(t=>!t.disabled&&!t.unavailable).map(t=>t.name)};},
 description(value){
  const v=parse(z.object({name:z.literal(TAVILY_SEARCH),category:z.literal('Search'),provider:z.literal('Tavily'),params:z.record(z.string(),z.unknown()),cost:z.object({credits_per_call:z.number()}).strict(),health:z.object({healthy:z.literal(true)}).strict(),execute_as:z.object({name:z.literal(TAVILY_SEARCH),params:z.object({query:z.literal('<The search query to execute with Tavily.>')}).strict()}).strict(),summary:z.string().max(2000).optional(),description:z.string().max(20000).optional(),tags:z.array(z.string().max(200)).max(10).optional()}).strict(),value);
  if(contractHash(v.params)!==contractHash(tavilySchema))throw new ResearchError('SCHEMA_CHANGED');
  creditsToUnits(v.cost.credits_per_call);
  // Only the observed same-name query placeholder is normalized. Never execute this template.
  return {name:v.name,schema:v.params,creditsPerCall:v.cost.credits_per_call};
 },
 validateInput(context){request(context);},
 result(value,context){
  const p=request(context);
  const v=parse(z.object({category:z.literal('search'),provider:z.literal('Tavily'),took_ms:z.number().int().nonnegative(),data:z.object({query:z.string().max(200),answer:z.null(),follow_up_questions:z.null(),images:z.array(z.unknown()).length(0),response_time:z.number().finite().nonnegative(),results:z.array(result).max(3),usage:z.object({credits:z.number().int().nonnegative()}).strict()}).strict()}).strict(),value);
  if(v.data.query!==p.query||v.data.results.length>p.max_results)throw new ResearchError('RESULT_IDENTITY_MISMATCH');
  if(new Set(v.data.results.map(r=>r.id)).size!==v.data.results.length)throw new ResearchError('DUPLICATE_RESULT_ID');
  return {objects:v.data.results.map(r=>({id:r.id,sourceUrl:r.url,observedAt:null,missingFields:['publishedAt'],fields:{kind:'web-search',title:r.title,content:r.content,score:r.score,query:p.query,coverage:'ranked-results-not-exhaustive',providerUsage:{unit:'tavily-credit',credits:v.data.usage.credits}}})),pagination:{complete:true,nextCursor:null},actualCredits:null};
 },
};
