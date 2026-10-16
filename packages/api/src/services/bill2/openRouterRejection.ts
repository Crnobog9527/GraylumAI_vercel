/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseExactJson } from './decimal';
import { decodeOpenRouterStreamObservation, validGenerationId } from './openRouterEvidence';
import { unknownEvidence, type CallIdentity, type TransportObservation } from './fixtureAdapter';

const rejection = z.object({user_id:z.string().nullable().optional(),error:z.object({code:z.literal(402),message:z.string(),metadata:z.object({
  limit_source:z.enum(['openrouter_key_limit','openrouter_credits','openrouter_in_flight_budget']),
  reason:z.string().optional(),remedy_hint:z.string().optional(),provider_name:z.string().nullable().optional(),
}).strict()}).strict()}).strict();

/** Other complete pre-generation refusals (0261). Metadata is shape-checked only and never stored. */
export const PRE_GENERATION_REFUSALS:ReadonlySet<number>=new Set([400,401,403,422,429]);
const refusal=(status:number)=>z.object({user_id:z.string().nullable().optional(),error:z.object({code:z.literal(status),
  message:z.string(),metadata:z.record(z.string(),z.unknown()).optional()}).strict()}).strict();

/** Only the complete official POST refusal, never a lookup or an SSE error.
 * No missing usage is treated as zero: SQL receives a distinct rejection proof.
 * A 402 may settle at once; any other refusal is only pending until a lookup confirms no generation.
 */
export function openRouterRejection(observation:TransportObservation, identity:CallIdentity, requestHash:string) {
  const status=observation.httpStatus;
  if(identity.provider!=='openrouter'||identity.protocol!=='openrouter-chat-v1'||
    status===undefined||status!==402&&!(PRE_GENERATION_REFUSALS.has(status)&&observation.generationId!==undefined)||
    !observation.complete||observation.transportIssue||
    (observation.generationId!==undefined&&!validGenerationId(observation.generationId))||
    !/^[a-f0-9]{64}$/.test(requestHash))return null;
  try {
    const bytes=observation.rawBodyEncoding==='gzip-base64'?decodeOpenRouterStreamObservation(observation)
      :Buffer.from(observation.rawBodyBase64,'base64');
    if(bytes.length>65536||bytes.toString('base64')!==observation.rawBodyBase64&&
      observation.rawBodyEncoding!=='gzip-base64')return null;
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(observation.rawBodyEncoding!=='gzip-base64'&&raw!==observation.rawBody)return null;
    // Reject duplicate keys before Zod sees JSON.parse's last-key-wins object.
    parseExactJson(raw,65536);
    if(!(status===402?rejection:refusal(status)).safeParse(JSON.parse(raw)).success)return null;
    const sourceHash=createHash('sha256').update(bytes).digest('hex');
    if(sourceHash!==observation.sourceHash)return null;
    return {...unknownEvidence(identity),source:'response',sourceHash,rawBody:raw,
      providerId:observation.generationId??null,
      evidenceKind:observation.generationId?'provider_rejection_pending' as const:'provider_rejection' as const,
      requestHash,transport:observation};
  } catch { return null; }
}
