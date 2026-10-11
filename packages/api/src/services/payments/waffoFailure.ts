/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createPrivateKey, createPublicKey } from 'node:crypto';

/** Why a Waffo call failed, for logs only. Never carries key material, signatures, headers,
 * request bodies or checkout URLs; provider notices are truncated. */
export type WaffoFailureCategory =
  | 'private_key_invalid' | 'timeout' | 'network' | 'http_status' | 'non_json'
  | 'provider_errors' | 'empty_data' | 'response_shape' | 'database';
export type WaffoFailureDetail = {
  category: WaffoFailureCategory; stage?: string; path?: string; httpStatus?: number;
  providerErrors?: { layer: string | null; message: string }[];
  errorName?: string; errorCode?: string; keyShape?: Record<string, boolean>;
};

/** The thrown message stays the existing control-flow code (callers compare it); `detail` is
 * the loggable reason. */
export class WaffoFailure extends Error {
  constructor(message: string, readonly detail: WaffoFailureDetail) { super(message); this.name = 'WaffoFailure'; }
}

const clip = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');

export function providerNotices(envelope: unknown) {
  const errors = (envelope as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return undefined;
  return errors.slice(0, 3).map((notice: { layer?: unknown; message?: unknown }) => ({
    layer: typeof notice?.layer === 'string' ? clip(notice.layer, 40) : null, message: clip(notice?.message),
  }));
}

/** Shape facts about a configured key, safe to log: which formatting a dashboard paste produced. */
function keyShape(raw: string) {
  return { hasPemHeader: /-----BEGIN [A-Z ]*KEY-----/.test(raw), hasRealNewlines: raw.includes('\n'),
    hasLiteralBackslashN: raw.includes('\\n'), hasCarriageReturns: raw.includes('\r'),
    hasSurroundingQuotes: /^\s*["']/.test(raw) };
}

/** Same normalisation the official Pancake SDK applies (@waffo/pancake-ts 0.26.0 signing.ts, used for
 * the #802 measured runs): literal "\n" from single-line env pastes, CRLF, and bare base64 bodies
 * are re-wrapped into PEM. Throws a categorised failure instead of signing with an unparsable key. */
function normalizePem(raw: string, kind: 'PRIVATE' | 'PUBLIC') {
  const header = new RegExp(`-----(BEGIN|END) (RSA )?${kind} KEY-----`, 'g');
  const pem = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  const pkcs1 = pem.includes(`-----BEGIN RSA ${kind} KEY-----`);
  const body = pem.replace(header, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  const label = `${pkcs1 ? 'RSA ' : ''}${kind} KEY`;
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----`;
}

export function normalizeWaffoPrivateKey(raw: string) {
  const pem = normalizePem(raw, 'PRIVATE');
  try { if (pem) { createPrivateKey(pem); return pem; } } catch { /* categorised below */ }
  throw new WaffoFailure('PAY_WAFFO_TEST_CONFIG_INVALID', { category: 'private_key_invalid', keyShape: keyShape(raw) });
}

/** Webhook verification fails closed on an unusable key; normalising only removes paste artefacts. */
export function normalizeWaffoPublicKey(raw: string) {
  const pem = normalizePem(raw, 'PUBLIC');
  try { if (pem) { createPublicKey(pem); return pem; } } catch { /* fall back to the raw value */ }
  return raw;
}

/** Loggable summary of any error thrown on a Waffo payment path. */
export function describeWaffoFailure(error: unknown): Record<string, unknown> {
  if (error instanceof WaffoFailure) return { code: error.message, ...error.detail };
  if (error instanceof Error) {
    const zod = error.name === 'ZodError';
    return { code: zod ? 'PAY_WAFFO_RESPONSE_SHAPE' : clip(error.message, 120), errorName: error.name,
      ...(zod ? { category: 'response_shape', issues: clip(JSON.stringify((error as { issues?: unknown[] }).issues?.slice(0, 3)
        ?.map((issue) => ({ path: (issue as { path?: unknown }).path, code: (issue as { code?: unknown }).code })) ?? []), 400) } : {}) };
  }
  return { code: 'UNKNOWN', errorName: typeof error };
}
