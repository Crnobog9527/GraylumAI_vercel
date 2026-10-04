/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseExactJson } from './decimal';
import { unknownEvidence, type CallIdentity, type TransportObservation } from './fixtureAdapter';

export type RejectionRecovery = { attempt: number; claimedAt: string };
const notFound = z.object({
  user_id: z.string().nullable().optional(),
  error: z.object({ code: z.literal(404), message: z.string() }).strict(),
}).strict();

/** A complete missing-generation response, never a zero-cost receipt. SQL counts
 * distinct, time-spaced recovery claims and joins the original strict 402 proof.
 * Retain the body hash only; no provider message, user identifier or lookup URL.
 */
export function openRouterNotFound(observation: TransportObservation, identity: CallIdentity) {
  if (identity.provider !== 'openrouter' || identity.protocol !== 'openrouter-chat-v1' ||
    observation.httpStatus !== 404 || !observation.complete || observation.transportIssue ||
    observation.generationId !== undefined || observation.stream || observation.rawBodyEncoding) return null;
  try {
    const bytes = Buffer.from(observation.rawBodyBase64, 'base64');
    if (bytes.length > 65536 || bytes.toString('base64') !== observation.rawBodyBase64) return null;
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (raw !== observation.rawBody) return null;
    parseExactJson(raw, 65536);
    if (!notFound.safeParse(JSON.parse(raw)).success) return null;
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (sourceHash !== observation.sourceHash) return null;
    return { ...unknownEvidence(identity), source: 'lookup', sourceHash,
      evidenceKind: 'provider_rejection_lookup' as const,
      transport: { httpStatus: 404, complete: true, transportIssue: null } };
  } catch { return null; }
}
