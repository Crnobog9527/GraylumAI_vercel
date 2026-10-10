/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createVerify } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const resourceId = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const envelope = z.object({
  eventType: z.string().regex(/^[a-z_]+\.[a-z_]+$/), eventId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  storeId: resourceId, mode: z.enum(['test', 'prod']),
  data: z.object({ orderId: resourceId, paymentId: resourceId.optional(),
    subscriptionId: resourceId.optional(), refundId: resourceId.optional(), checkoutId: resourceId.optional() }),
});
export const WAFFO_MAX_BODY_BYTES = 256 * 1024;
export const WAFFO_SIGNATURE_WINDOW_MS = 45 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;

/** Verify original bytes before JSON parsing. Expired, valid signatures may ONLY enqueue
 * authoritative lookup; their body is never payment or entitlement evidence. */
export function verifyWaffoReceipt(input: {
  body: Uint8Array; signature: string | null; publicKey: string; storeId: string;
  merchantNamespace: string; now?: number;
}) {
  if (!input.body.byteLength || input.body.byteLength > WAFFO_MAX_BODY_BYTES) throw new Error('WAFFO_BODY_INVALID');
  const parts = /^t=([0-9]{13}),v1=([A-Za-z0-9+/]+={0,2})$/.exec(input.signature ?? '');
  if (!parts || !/^[A-Za-z0-9_-]{1,64}$/.test(input.merchantNamespace)) throw new Error('WAFFO_SIGNATURE_INVALID');
  const timestamp = Number(parts[1]);
  const age = (input.now ?? Date.now()) - timestamp;
  if (!Number.isSafeInteger(timestamp) || age < -FUTURE_SKEW_MS) throw new Error('WAFFO_SIGNATURE_INVALID');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[1]}.`);
  verifier.update(input.body);
  let valid = false;
  try { valid = verifier.verify(input.publicKey, parts[2]!, 'base64'); } catch { /* fail closed */ }
  if (!valid) throw new Error('WAFFO_SIGNATURE_INVALID');
  const event = envelope.parse(JSON.parse(Buffer.from(input.body).toString('utf8')));
  // Deliberately no production key selection from an untrusted header or body.
  if (event.mode !== 'test' || event.storeId !== input.storeId) throw new Error('WAFFO_SCOPE_MISMATCH');
  return {
    merchant: input.merchantNamespace, mode: 'test' as const,
    type: event.eventType, id: event.eventId,
    digest: createHash('sha256').update(input.body).digest('hex'),
    refs: event.data, requiresLookup: age > WAFFO_SIGNATURE_WINDOW_MS,
  };
}

/** A 2xx response is allowed only after durable receipt. No raw payload or buyer PII is stored.
 * Every receipt is recovered by original resource identity; lifecycle events never grant credits. */
export async function receiveWaffoWebhook(input: Parameters<typeof verifyWaffoReceipt>[0] & {
  db: Pick<SupabaseClient, 'rpc'>;
}) {
  const receipt = verifyWaffoReceipt(input);
  const result = await input.db.rpc('pay_waffo_receive_event', {
    p_merchant: receipt.merchant, p_mode: receipt.mode, p_type: receipt.type,
    p_id: receipt.id, p_digest: receipt.digest, p_refs: receipt.refs,
  });
  if (result.error || typeof result.data !== 'string' || !result.data) throw new Error('WAFFO_RECEIPT_UNAVAILABLE');
  return { receiptId: result.data, requiresLookup: receipt.requiresLookup };
}
