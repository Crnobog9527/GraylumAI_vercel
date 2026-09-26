/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {OpenRouterLimits} from './openRouterPolicy';
import { decimal, parseExactJson } from './decimal';
const amount = z.string().refine((v) => { try { decimal(v); return true; } catch { return false; } });
const receipt = z.object({
  id: z.string().min(1).max(256).nullable(), model: z.string().min(1).max(256),
  final: z.boolean(), cost: amount.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  coverage: z.enum(['request_total', 'included_detail']), detailId: z.string().min(1).max(128).optional(),
  includedDetails: z.array(z.object({ cost: amount, currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(128).default([]),
  usage: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(v=>v.coverage!=='included_detail'||Boolean(v.detailId));
export type CallIdentity = { provider: string; account: string; model: string; protocol: 'fixture-cost-v1' | 'openrouter-chat-v1'; providerLimits?:OpenRouterLimits; outputLimit?:number; upperUsd?:string };
export function fixtureEvidence(raw: string, identity: CallIdentity, source: 'response' | 'lookup') {
  const parsed = receipt.parse(parseExactJson(raw));
  return { ...identity, model: parsed.model, providerId: parsed.id, cost: parsed.cost, currency: parsed.currency,
    final: parsed.final, coverage: parsed.coverage, detailId: parsed.detailId, includedDetails: parsed.includedDetails, usage: parsed.usage ?? null,
    source, sourceHash: createHash('sha256').update(raw).digest('hex'), observedAt: new Date().toISOString(), rawBody: raw };
}
/** Transport evidence survives schema rejection. Invalid money is never accepted for settlement. */
export function observedFixtureEvidence(raw: string, identity: CallIdentity, source: 'response' | 'lookup') {
  try { return fixtureEvidence(raw, identity, source); }
  catch {
    let providerId: string | null = null;
    try { const value = parseExactJson(raw) as Record<string, unknown>;
      if (value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256) providerId = value.id;
    } catch { /* bounded raw body remains evidence even when JSON is malformed */ }
    return { ...unknownEvidence(identity), providerId, source, sourceHash: createHash('sha256').update(raw).digest('hex'),
      rawBody: raw, rejectedReason: 'invalid_protocol_receipt' };
  }
}
export function unknownEvidence(identity: CallIdentity) {
  return { ...identity, providerId: null, cost: null, currency: 'USD', final: false, coverage: 'request_total',
    source: 'transport_unknown', sourceHash: createHash('sha256').update('transport_unknown').digest('hex'), observedAt: new Date().toISOString() };
}
/** Private bounded HTTP observation; receiving a response is not a receipt or delivery verdict. */
export type TransportObservation = { rawBody: string; rawBodyBase64: string; sourceHash: string; httpStatus: number; complete: boolean; transportIssue: string | null };
export function transportEvidence(observation: TransportObservation, identity: CallIdentity, source: 'response' | 'lookup') {
  if (observation.httpStatus >= 200 && observation.httpStatus < 300 && observation.complete) {
    return { ...observedFixtureEvidence(observation.rawBody, identity, source), transport: { httpStatus: observation.httpStatus, complete: observation.complete, transportIssue: observation.transportIssue } };
  }
  let providerId: string | null = null;
  // Do not guess IDs from malformed JSON or a retained prefix of an incomplete response.
  if (observation.complete) {
    try { const value = parseExactJson(observation.rawBody) as Record<string, unknown>;
      if (value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256) providerId = value.id;
    } catch { /* exact bounded bytes remain private diagnostic evidence */ }
  }
  return { ...unknownEvidence(identity), evidenceKind: 'transport_observation', providerId, source,
    ...observation }; // Financial fields remain unknown regardless of status/body cost/finality.
}
/** Only the explicit local protocol is implemented. This is not an OpenRouter/Fusion capability assertion. */
export function localFixtureAdapter(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('BILL2_REAL_PROVIDER_DISABLED');
  async function request(path: string, body?: unknown): Promise<TransportObservation> {
    const response = await fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const chunks: Uint8Array[] = []; let bytes = 0, complete = false, transportIssue: string | null = null;
    const reader = response.body?.getReader();
    if (reader) {
      try { for (;;) { const next = await reader.read(); if (next.done) { complete = true; break; }
        const retained = next.value.subarray(0, 65_536 - bytes); chunks.push(retained); bytes += retained.length;
        if (retained.length < next.value.length) { transportIssue = 'body_limit'; break; }
      } } catch { transportIssue = 'body_interrupted'; }
      finally { await reader.cancel().catch(() => {}); }
    } else { complete = true; }
    const retained = Buffer.concat(chunks); let rawBody: string;
    try { rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(retained); if (rawBody.includes('\0')) throw new Error('invalid_text'); }
    catch { rawBody = retained.toString('utf8').replaceAll('\0', '\uFFFD'); complete = false; transportIssue ??= 'invalid_text'; }
    return { rawBody, rawBodyBase64: retained.toString('base64'), sourceHash: createHash('sha256').update(retained).digest('hex'), httpStatus: response.status, complete, transportIssue };
  }
  return { protocol: 'fixture-cost-v1' as const, lookupSupported: true,
    dispatch: (body: unknown) => request('/call', body),
    lookup: (providerId: string) => request('/receipt/' + encodeURIComponent(providerId)) };
}
