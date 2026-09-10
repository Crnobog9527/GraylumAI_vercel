/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
// Reviewed GenerateContent google_search models, not an inference from provider
// labels. OpenAI-compatible gateways do not expose this native contract.
const promptModels = new Set(['gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.0-flash']);
const queryModels = new Set(['gemini-3-flash-preview','gemini-3.1-pro-preview','gemini-3.1-flash-lite-preview','gemini-3.1-flash-lite','gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.6-flash','gemini-3.7-flash','gemini-3.8-flash']);
export type SearchBillingUnit='grounded-prompt'|'unique-query';
export function nativeSearchCapability(model:{provider:string;modelId:string;enableWebSearch:boolean},openAICompatible:boolean):SearchBillingUnit|null {
  if(!model.enableWebSearch||openAICompatible||model.provider!=='google')return null;
  return promptModels.has(model.modelId)?'grounded-prompt':queryModels.has(model.modelId)?'unique-query':null;
}
export function safeSearchUrl(value:string):boolean {
  try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}
}
const source=z.object({title:z.string().max(2000),url:z.string().max(4096).refine(safeSearchUrl)});
export const searchEvidenceSchema=z.object({
  requested:z.boolean(),available:z.boolean(),status:z.enum(['not_requested','unavailable','verified','unknown']),
  executed:z.boolean().nullable(),queries:z.array(z.string().max(4096)).max(1000).nullable(),queryCount:z.number().int().min(0).max(1000).nullable(),
  providerUnit:z.enum(['grounded-prompt','unique-query','search-query']).nullable(),providerUnits:z.number().int().min(0).max(1000).nullable(),
  surchargeUnits:z.number().int().min(0).max(1000).nullable(),surchargeCredits:z.number().int().min(0).nullable(),
  sources:z.array(source).max(100),suggestionsHtml:z.string().max(65536).optional(),
});
export type SearchEvidence=z.infer<typeof searchEvidenceSchema>;
export function publicSearchEvidence(value:unknown):SearchEvidence|null {
  const result=searchEvidenceSchema.safeParse(value);return result.success?result.data:null;
}
const grounding=z.object({
  webSearchQueries:z.array(z.string().max(4096)).max(1000).optional(),
  groundingChunks:z.array(z.object({web:z.object({uri:z.string().max(4096),title:z.string().max(2000).optional()}).optional()})).max(100).optional(),
  searchEntryPoint:z.object({renderedContent:z.string().max(65536).optional()}).optional(),
});
/** Metadata snapshots are not deltas. Reject contradictory snapshots rather
 * than sum source/citation counts or infer execution from generated prose. */
export function geminiSearchCollector(unit:SearchBillingUnit) {
  let last:z.infer<typeof grounding>|undefined, invalid=false;
  return {
    observe(value:unknown){
      const parsed=grounding.safeParse(value);
      if(!parsed.success){invalid=true;return;}
      const next={...last,...parsed.data};
      const queries=new Set((next.webSearchQueries??[]).filter(q=>q.trim()));
      if(last?.webSearchQueries?.some(q=>q.trim()&&!queries.has(q)))invalid=true;
      if(next.webSearchQueries&&queries.size===0&&((next.groundingChunks?.length??0)>0||next.searchEntryPoint?.renderedContent))invalid=true;
      last=next;
    },
    finish(){
      if(!last?.webSearchQueries||invalid)throw new Error('SEARCH_EVIDENCE_UNAVAILABLE');
      const queries=[...new Set(last.webSearchQueries.filter(q=>q.trim()))];
      const sources=(last.groundingChunks??[]).flatMap(c=>c.web&&safeSearchUrl(c.web.uri)?[{url:c.web.uri,title:c.web.title??c.web.uri}]:[]);
      return {queries,queryCount:queries.length,providerUnit:unit,providerUnits:unit==='unique-query'?queries.length:Number(queries.length>0),sources:[...new Map(sources.map(s=>[s.url,s])).values()],suggestionsHtml:last.searchEntryPoint?.renderedContent};
    },
  };
}
