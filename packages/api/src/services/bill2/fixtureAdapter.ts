/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decimal, parseExactJson } from './decimal';
const amount = z.string().refine((v) => { try { decimal(v); return true; } catch { return false; } });
const receipt = z.object({
  id: z.string().min(1).max(256).nullable(), model: z.string().min(1).max(256),
  final: z.boolean(), cost: amount.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  coverage: z.enum(['request_total', 'included_detail']),
  includedDetails: z.array(z.object({ cost: amount, currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(128).default([]),
  usage: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CallIdentity = { provider: string; account: string; model: string; protocol: 'fixture-cost-v1' };
export function fixtureEvidence(raw: string, identity: CallIdentity, source: 'response' | 'lookup') {
  const parsed = receipt.parse(parseExactJson(raw));
  return { ...identity, model: parsed.model, providerId: parsed.id, cost: parsed.cost, currency: parsed.currency,
    final: parsed.final, coverage: parsed.coverage, includedDetails: parsed.includedDetails, usage: parsed.usage ?? null,
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
/** Only the explicit local protocol is implemented. This is not an OpenRouter/Fusion capability assertion. */
export function localFixtureAdapter(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('BILL2_REAL_PROVIDER_DISABLED');
  async function request(path: string, body?: unknown) {
    const response = await fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    // No retries and no inference from HTTP status. Preserve bounded raw evidence only on successful protocol responses.
    if (!response.ok || !response.body) throw new Error('BILL2_TRANSPORT_UNKNOWN');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
      if (bytes > 65_536) throw new Error('BILL2_EVIDENCE_TOO_LARGE'); chunks.push(next.value); } }
    finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  return { protocol: 'fixture-cost-v1' as const, lookupSupported: true,
    dispatch: (body: unknown) => request('/call', body),
    lookup: (providerId: string) => request('/receipt/' + encodeURIComponent(providerId)) };
}
