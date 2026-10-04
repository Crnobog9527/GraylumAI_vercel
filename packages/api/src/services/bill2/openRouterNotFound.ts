/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseExactJson } from './decimal';
import { unknownEvidence, type CallIdentity, type TransportObservation } from './fixtureAdapter';

export type RejectionRecovery = { attempt: number; claimedAt: string; queryCount?: number; queryTimes?: string[]; queryOutcomes?: string[] };
const notFound = z.object({
  user_id: z.string().nullable().optional(),
  error: z.object({ code: z.literal(404), message: z.string() }).strict(),
}).strict();

/** An official missing-cost observation. Only SQL joining the original strict
 * 402 proof may apply the Owner-approved immediate refusal exception.
 * Retain the body hash only; no provider message, user identifier or lookup URL.
 */
export function openRouterNotFound(observation: TransportObservation, identity: CallIdentity, expectedProviderId?: string) {
  if (identity.provider !== 'openrouter' || identity.protocol !== 'openrouter-chat-v1' ||
    ![200, 404].includes(observation.httpStatus) || !observation.complete || observation.transportIssue ||
    observation.generationId !== undefined || observation.stream || observation.rawBodyEncoding) return null;
  try {
    const bytes = Buffer.from(observation.rawBodyBase64, 'base64');
    if (bytes.length > 65536 || bytes.toString('base64') !== observation.rawBodyBase64) return null;
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (raw !== observation.rawBody) return null;
    parseExactJson(raw, 65536);
    const root = JSON.parse(raw);
    const missing = observation.httpStatus === 404;
    if (missing ? !notFound.safeParse(root).success : !noCostRecord(root, identity, expectedProviderId)) return null;
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (sourceHash !== observation.sourceHash) return null;
    return { ...unknownEvidence(identity), source: 'lookup', sourceHash,
      evidenceKind: 'provider_rejection_lookup' as const,
      lookupOutcome: missing ? 'not_found' as const : 'no_cost' as const,
      providerId: missing ? null : expectedProviderId!,
      transport: { httpStatus: observation.httpStatus, complete: true, transportIssue: null } };
  } catch { return null; }
}

/** Missing cost is not a general refund rule. This projection is used only with
 * a durable strict refusal. Any amount (including zero), usage or output falls
 * back to the ordinary evidence rules. Unknown fields remain conservative. */
function noCostRecord(root: unknown, identity: CallIdentity, expectedId?: string): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root) || !expectedId) return false;
  const outer = root as Record<string, unknown>;
  if (Object.keys(outer).some(key => !['data', 'user_id'].includes(key))) return false;
  const data = outer.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record.id !== expectedId || record.model !== identity.model || record.total_cost != null) return false;
  const harmless = new Set(['id', 'model', 'total_cost', 'finish_reason', 'native_finish_reason', 'user_id',
    'created_at', 'provider_name', 'upstream_id', 'is_byok', 'streamed', 'cancelled', 'latency', 'generation_time',
    'moderation_latency', 'origin', 'app_id']);
  const tokens = new Set(['tokens_prompt', 'tokens_completion', 'native_tokens_prompt', 'native_tokens_completion',
    'native_tokens_reasoning', 'native_tokens_cached']);
  return Object.entries(record).every(([key, value]) => harmless.has(key) ||
    (tokens.has(key) && (value === null || value === 0)));
}
