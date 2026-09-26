/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { decimal, parseExactJson } from './decimal';
import type { TransportObservation } from './fixtureAdapter';
// A lookup identity only, never a cost receipt. Exclude whitespace, delimiters
// and control characters (including combined duplicate HTTP header values).
export const validGenerationId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(value);
export type OpenRouterIdentity = {provider:'openrouter';account:string;model:string;protocol:'openrouter-chat-v1'};
/** JSON may encode a small official cost with an exponent. Expand digits
 * exactly, never via Number; unsupported ledger precision stays unknown. */
function officialCost(value:unknown):string {
 if(typeof value!=='string')throw new Error('BILL2_INVALID_DECIMAL');
 const match=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
 if(!match)throw new Error('BILL2_INVALID_DECIMAL');
 const whole=match[1]!,fraction=match[2]??'',exponent=Number(match[3]??0);
 if(Math.abs(exponent)>100)throw new Error('BILL2_INVALID_DECIMAL');
 const digits=whole+fraction,point=whole.length+exponent;
 const expanded=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
 const [integer,part='']=expanded.split('.');
 const canonical=integer!.replace(/^0+(?=\d)/,'')+(part.replace(/0+$/,'')?'.'+part.replace(/0+$/,''):'');
 decimal(canonical);return canonical;
}
/** Server-observed official response only; no browser receipt endpoint.
 * https://openrouter.ai/docs/cookbook/administration/usage-accounting
 * Cost finality is separate from whether a usable answer was delivered.
 */
export function openRouterEvidence(observation:TransportObservation, identity:OpenRouterIdentity, source:'response'|'lookup', expectedProviderId?:string) {
  const base={...identity,providerId:null as string|null,cost:null as string|null,currency:'USD',final:false,coverage:'request_total',
    source,sourceHash:createHash('sha256').update(Buffer.from(observation.rawBodyBase64,'base64')).digest('hex'),
    observedAt:new Date().toISOString(),rawBody:observation.rawBody,transport:observation,usage:null as Record<string,unknown>|null};
  const diagnostic=(reason:string)=>({...base,evidenceKind:'transport_observation' as const,rejectedReason:reason});
  if(validGenerationId(observation.generationId))base.providerId=observation.generationId;
  const mismatch=()=>({...base,providerId:null,rejectedReason:'identity_or_response_mismatch'});
  if(expectedProviderId&&base.providerId&&expectedProviderId!==base.providerId)return mismatch();
  if(!observation.complete)return diagnostic('incomplete_transport');
  let root:Record<string,unknown>;
  try { root=parseExactJson(observation.rawBody) as Record<string,unknown>; }
  catch{return diagnostic('invalid_json');}
  if(!root || typeof root!=='object')return diagnostic('invalid_response');
  const data=(source==='lookup'?root.data:root) as Record<string,unknown>|undefined;
  if(!data || typeof data!=='object')return diagnostic('invalid_response');
  const bodyId=typeof data.id==='string'&&data.id.length>0&&data.id.length<=256?data.id:null;
  // Do not bind either disputed ID: SQL must latch its existing conflict flag
  // before recovery or settlement can use contradictory evidence.
  if(bodyId&&((base.providerId&&bodyId!==base.providerId)||(expectedProviderId&&bodyId!==expectedProviderId)))return mismatch();
  if(bodyId)base.providerId=bodyId;
  if(observation.httpStatus<200||observation.httpStatus>=300)return diagnostic('http_observation_only');
  if(root.error || data.error || !bodyId || typeof data.model!=='string')return diagnostic('incomplete_response');
  if((expectedProviderId && expectedProviderId!==base.providerId) || data.model!==identity.model)
    return mismatch();
  const usage=data.usage as Record<string,unknown>|undefined;
  const cost=source==='lookup'?data.total_cost:usage?.cost;
  const choices=data.choices as Array<{finish_reason?:unknown}>|undefined;
  const finish=source==='lookup'?data.finish_reason:Array.isArray(choices)&&choices.length===1?choices[0]?.finish_reason:undefined;
  if(!['stop','length','content_filter','tool_calls'].includes(String(finish)))return diagnostic('nonterminal_response');
  // A terminal response can carry a usable answer while cost is unresolved.
  // Keep the original response available to Runtime; only financial finality
  // waits for an official lookup. Diagnostics do not establish zero cost.
  const responseUsage=source==='response'?{sdkResponse:JSON.parse(observation.rawBody)}:null;
  if(typeof cost!=='string')return {...base,usage:responseUsage,costIssue:'missing_cost'};
  let exactCost:string;
  try { exactCost=officialCost(cost); } catch{return {...base,usage:responseUsage,costIssue:'invalid_cost'};}
  return {...base,cost:exactCost,final:true,usage:responseUsage};
}
