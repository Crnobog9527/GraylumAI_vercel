/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import {OPENROUTER_RESPONSE_BYTE_LIMIT} from './responseCapacity';
import {gunzipSync} from 'node:zlib';
import { decimal, parseExactJson } from './decimal';
import {openRouterStream,OPENROUTER_STREAM_BYTE_LIMIT} from './openRouterStream';
import type { TransportObservation } from './fixtureAdapter';
import {AGENT_STREAM_TOOLS} from '../runtime/agentTools';
// A lookup identity only, never a cost receipt. Exclude whitespace, delimiters
// and control characters (including combined duplicate HTTP header values).
export const validGenerationId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(value);
export type OpenRouterIdentity = {provider:'openrouter';account:string;model:string;protocol:'openrouter-chat-v1'};
/** Streaming and large nonstream observations use reversible compression. Decode before parsing,
 * with an independent allocation bound and hashes over original provider bytes. */
export function decodeOpenRouterStreamObservation(observation:TransportObservation):Buffer {
 const limit=observation.stream?OPENROUTER_STREAM_BYTE_LIMIT:OPENROUTER_RESPONSE_BYTE_LIMIT;
 const encoded=observation.rawBodyBase64;
 if(observation.rawBodyOmitted||encoded.length>Math.ceil((limit+2048)/3)*4||
   encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('invalid_stream_encoding');
 const packed=Buffer.from(encoded,'base64');
 if(packed.toString('base64')!==encoded)throw new Error('invalid_stream_encoding');
 if(observation.rawBodyEncoding!=='gzip-base64')throw new Error('invalid_stream_encoding');
 const bytes=gunzipSync(packed,{maxOutputLength:limit});
 const hash=createHash('sha256').update(bytes).digest('hex');
 if(observation.rawBody!==''||bytes.length!==observation.rawBodyByteLength||hash!==observation.rawBodySha256||
   !Number.isSafeInteger(observation.observedByteLength)||observation.observedByteLength!<bytes.length||
   !/^[a-f0-9]{64}$/.test(observation.sourceHash)||
   (observation.complete&&(observation.observedByteLength!==bytes.length||observation.sourceHash!==hash)))throw new Error('invalid_stream_encoding');
 return bytes;
}
// PostgreSQL jsonb adds spaces and expands exponent-form numbers. Count every
// colon/comma (even in strings) and reserve 400 bytes per finite JS number plus
// 16 KiB for SQL-added identity metadata. This deliberately overestimates size.
function receiptIssue(value:unknown):'invalid_receipt_text'|'receipt_size_limit'|null {
 let numbers=0,invalidText=false;
 const json=JSON.stringify(value,(_key,item)=>{if(typeof item==='number')numbers++;if(typeof item==='string'&&(item.includes('\0')||!item.isWellFormed()))invalidText=true;return item;});
 if(invalidText)return 'invalid_receipt_text';
 return Buffer.byteLength(json)+(json.match(/[:,]/g)?.length??0)+numbers*400<=524288-16384?null:'receipt_size_limit';
}
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
/** Preserve malformed present values so SQL distinguishes conflict from missing evidence.
 * parseExactJson supplies numeric lexemes; only integral nonnegative forms normalize. */
function tokenEvidence(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
  if (!match) return value;
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 100) return value;
  const digits = BigInt(match[1]! + fraction), shift = exponent - fraction.length;
  if (shift >= 0) return (digits * 10n ** BigInt(shift)).toString();
  const divisor = 10n ** BigInt(-shift);
  return digits % divisor === 0n ? (digits / divisor).toString() : value;
}
function canonicalUsage(data: Record<string, unknown>, source: 'response' | 'lookup'): Record<string, unknown> {
  const usage = data.usage as Record<string, unknown> | undefined;
  const prompt = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
  const completion = usage?.completion_tokens_details as Record<string, unknown> | undefined;
  const fields = source === 'response' ? {
    inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens,
    reasoningTokens: completion?.reasoning_tokens, cachedTokens: prompt?.cached_tokens,
    cacheCreationTokens: prompt?.cache_write_tokens,
  } : {
    inputTokens: data.native_tokens_prompt, outputTokens: data.native_tokens_completion,
    reasoningTokens: data.native_tokens_reasoning, cachedTokens: data.native_tokens_cached,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, tokenEvidence(value)]));
}
/** Server-observed official response only; no browser receipt endpoint.
 * https://openrouter.ai/docs/cookbook/administration/usage-accounting
 * Cost finality is separate from whether a usable answer was delivered.
 */
function projectOpenRouterEvidence(observation:TransportObservation, identity:OpenRouterIdentity, source:'response'|'lookup', expectedProviderId?:string) {
  const base={...identity,providerId:null as string|null,cost:null as string|null,currency:'USD',final:false,coverage:'request_total',
    source,sourceHash:observation.rawBodyEncoding==='gzip-base64'?observation.sourceHash:
     createHash('sha256').update(Buffer.from(observation.rawBodyBase64,'base64')).digest('hex'),
    observedAt:new Date().toISOString(),rawBody:observation.rawBody,transport:observation,usage:null as Record<string,unknown>|null};
  const diagnostic=(reason:string)=>({...base,evidenceKind:'transport_observation' as const,rejectedReason:reason});
  if(validGenerationId(observation.generationId))base.providerId=observation.generationId;
  const mismatch=()=>({...base,providerId:null,rejectedReason:'identity_or_response_mismatch'});
  if(expectedProviderId&&base.providerId&&expectedProviderId!==base.providerId)return mismatch();
  let root:Record<string,unknown>;let sdkResponse:unknown;
  if(observation.stream&&source==='response'){
   let wire:string;
   try{wire=new TextDecoder('utf-8',{fatal:true}).decode(decodeOpenRouterStreamObservation(observation));}catch{return diagnostic('invalid_stream_encoding');}
   // An Agent turn response (AC-1) keeps its own tool rules; older bytes carry no flag.
   const stream=openRouterStream(identity.model,base.providerId??undefined,undefined,observation.agentTools?AGENT_STREAM_TOOLS:undefined);
   stream.push(wire);const result=stream.result();
   if(result.identityConflict)return mismatch();
   if(result.providerId)base.providerId=result.providerId;
   if(expectedProviderId&&base.providerId&&expectedProviderId!==base.providerId)return mismatch();
   if(!observation.complete)return diagnostic('incomplete_transport');
   if(result.error||!result.sdkResponse)return diagnostic(result.error??'invalid_stream');
   sdkResponse=result.sdkResponse;
   root={...result.sdkResponse,usage:result.exactUsage};
   // runtime_response replays a normal SDK completion. Original SSE bytes and
   // their hash remain in transport; never hash this synthesized projection.
   base.rawBody=JSON.stringify(sdkResponse);
  }else{
   if(!observation.complete)return diagnostic('incomplete_transport');
   try {
    const raw=observation.rawBodyEncoding==='gzip-base64'?
     new TextDecoder('utf-8',{fatal:true}).decode(decodeOpenRouterStreamObservation(observation)):observation.rawBody;
    root=parseExactJson(raw,source==='response'?OPENROUTER_RESPONSE_BYTE_LIMIT:65536) as Record<string,unknown>;
    sdkResponse=JSON.parse(raw);base.rawBody=raw;
   }
   catch{return diagnostic('invalid_json');}
  }
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
  const tokens=canonicalUsage(data,source);
  const responseUsage=source==='response'?{...tokens,sdkResponse}:Object.keys(tokens).length?tokens:null;
  if(typeof cost!=='string')return {...base,usage:responseUsage,costIssue:'missing_cost'};
  let exactCost:string;
  try { exactCost=officialCost(cost); } catch{return {...base,usage:responseUsage,costIssue:'invalid_cost'};}
  return {...base,cost:exactCost,final:true,usage:responseUsage};
}

/** Bound the durable receipt, not the accepted SSE stream. Extreme entropy may
 * prevent reversible storage; retain only observed identity/hash diagnostics in
 * that case. No terminal/cost assertion survives omission of provider bytes. */
export function openRouterEvidence(observation:TransportObservation,identity:OpenRouterIdentity,source:'response'|'lookup',expectedProviderId?:string){
 const evidence=projectOpenRouterEvidence(observation,identity,source,expectedProviderId);
 if(!observation.stream&&observation.rawBodyEncoding!=='gzip-base64')return evidence;
 const issue=receiptIssue(evidence);if(!issue)return evidence;
 const conflict='rejectedReason' in evidence&&evidence.rejectedReason==='identity_or_response_mismatch';
 return {...evidence,rawBody:'',usage:null,cost:null,final:false,
  // SQL's ordinary rejected-receipt branch latches identity conflicts; do not
  // downgrade one to a transport-only observation during size reduction.
  ...(!conflict?{evidenceKind:'transport_observation' as const}:{}),
  rejectedReason:conflict?'identity_or_response_mismatch':issue,
  transport:{rawBody:'',rawBodyBase64:'',rawBodyOmitted:issue,
   rawBodyByteLength:observation.rawBodyByteLength,rawBodySha256:observation.rawBodySha256,
   observedByteLength:observation.observedByteLength,sourceHash:observation.sourceHash,
   httpStatus:observation.httpStatus,complete:observation.complete,transportIssue:observation.transportIssue,
   ...(observation.stream?{stream:true as const}:{})}};
}
