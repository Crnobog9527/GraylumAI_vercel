/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {safeSearchUrl} from './searchEvidence';
import {isOpenRouterEndpoint} from './providerUtils';

// Only the final, exact OpenRouter endpoint establishes this contract. Neither
// a vendor label, a compatible proxy nor a credential prefix is sufficient.
export function openRouterSearchCapability(endpoint:string,modelId:string,enabled:boolean) {
  return isOpenRouterEndpoint(endpoint)&&enabled&&isPlainOpenRouterModel(modelId);
}
export function isPlainOpenRouterModel(modelId:string) {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::(?:free|nitro|floor|exacto))?$/i.test(modelId)
    && !/^(?:openrouter|perplexity)\//i.test(modelId) && !/search|sonar/i.test(modelId);
}
export function openRouterSearchParameters(modelId:string,enabled:boolean) {
  // Presets merge tools, :online enables a legacy plugin, and some model APIs
  // search intrinsically. Never silently switch their model or hidden routing.
  if(!isPlainOpenRouterModel(modelId))throw new Error('OPENROUTER_SEARCH_POLICY_UNVERIFIED');
  return {plugins:[{id:'web',enabled:false}],tools:enabled?[{type:'openrouter:web_search'}]:[],
    tool_choice:enabled?'auto':'none',...(enabled?{max_tool_calls:3}:{})};
}
const counter=z.number().int().min(0).max(1000);
export function openRouterSearchCount(value:unknown):number|undefined {
  const usage=z.object({server_tool_use:z.unknown().optional(),server_tool_use_details:z.unknown().optional()}).parse(value);
  const counts=[usage.server_tool_use,usage.server_tool_use_details].filter(v=>v!=null).map(v=>z.object({web_search_requests:counter.nullish()}).parse(v).web_search_requests).filter(v=>v!=null);
  if(counts.length>1&&counts.some(v=>v!==counts[0]))throw new Error('SEARCH_EVIDENCE_CONFLICT');
  return counts[0];
}
const annotation=z.object({type:z.literal('url_citation'),url_citation:z.object({
  url:z.string().max(4096),title:z.string().max(2000),content:z.string().optional(),
  start_index:z.number().int().nonnegative().optional(),end_index:z.number().int().nonnegative().optional(),
})});
export function openRouterSearchCollector(enabled:boolean) {
  let count:number|undefined,highest=0,invalid=false,hasCitation=false;
  const sources=new Map<string,{url:string;title:string}>();
  return {
    observeAnnotations(value:unknown) {
      if(value===undefined)return;
      if(!Array.isArray(value)||value.length>100){invalid=true;return;}
      for(const raw of value){
        if(raw?.type!=='url_citation')continue;
        hasCitation=true;
        const parsed=annotation.safeParse(raw);
        if(!parsed.success){invalid=true;continue;}
        const v=parsed.data.url_citation;
        if(v.start_index!==undefined&&v.end_index!==undefined&&v.end_index<v.start_index)invalid=true;
        if(safeSearchUrl(v.url))sources.set(v.url,{url:v.url,title:v.title});
      }
      if(sources.size>100)invalid=true;
    },
    observeUsage(value:unknown) {
      count=openRouterSearchCount(value);
      if(count!==undefined){if(count<highest)invalid=true;highest=Math.max(highest,count);}
    },
    finish() {
      if(!enabled&&(highest>0||hasCitation))throw new Error('SEARCH_EXECUTION_NOT_ALLOWED');
      if(invalid||(enabled&&count===undefined)||(count===0&&hasCitation))throw new Error('SEARCH_EVIDENCE_UNAVAILABLE');
      if(!enabled)return undefined;
      return {queries:null,queryCount:count!,providerUnit:'search-query' as const,providerUnits:count!,sources:[...sources.values()]};
    },
  };
}
