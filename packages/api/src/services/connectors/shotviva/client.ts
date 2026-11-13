/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import {
  PARTNER_ACCOUNT_HEADER, accountResponseSchema, linkResponseSchema, partnerErrorSchema,
  type AccountResponse, type LinkResponse, type PartnerErrorCode,
} from './contract';

/** INTEGRATION-SHOTVIVA: the server-side Shotviva partner client. One fixed origin from configuration, the partner key
 * from the admin Vault, a timeout and a response-size cap on every call, no redirects; every answer is parsed with the
 * contract and anything else is "unavailable", never trusted. */
export class ShotvivaError extends Error {
  constructor(readonly code: PartnerErrorCode | 'unavailable', readonly status: number | null,
    readonly topUpUrl: string | null = null) { super(`SHOTVIVA_${code.toUpperCase()}`); }
}

export type ShotvivaClientOptions = {
  baseUrl: string; partnerKey: string; fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** https only (http just for a local test server), no credentials, no path: the origin requests are sent to. */
export function shotvivaOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
      || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new ShotvivaError('unavailable', response.status);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ShotvivaError('unavailable', response.status); }
    parts.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

export function createShotvivaClient(options: ShotvivaClientOptions) {
  const checked = shotvivaOrigin(options.baseUrl);
  if (!checked || !/^sv_(live|test)_/.test(options.partnerKey)) throw new ShotvivaError('unavailable', null);
  const origin: string = checked;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;

  async function call<T>(schema: z.ZodType<T>, path: string, init: { method: 'GET' | 'POST'; account?: string; body?: unknown;
    query?: Record<string, string | undefined> }): Promise<T> {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${options.partnerKey}`, Accept: 'application/json' };
    if (init.account) headers[PARTNER_ACCOUNT_HEADER] = init.account;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await send(url, { method: init.method, headers, redirect: 'error', cache: 'no-store',
        body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new ShotvivaError('unavailable', null); }
    const text = await readBounded(response, limit);
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { throw new ShotvivaError('unavailable', response.status); }
    if (!response.ok) {
      const error = partnerErrorSchema.safeParse(json);
      throw new ShotvivaError(error.success ? error.data.code : 'unavailable', response.status,
        error.success ? error.data.top_up_url ?? null : null);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ShotvivaError('unavailable', response.status);
    return parsed.data;
  }

  return {
    origin,
    /** The one-time code from the connect redirect → the Shotviva account (valid 10 minutes, usable once). */
    link: (code: string): Promise<LinkResponse> => call(linkResponseSchema, '/api/partner/link', { method: 'POST', body: { code } }),
    /** Credits of a linked account; top_up_url remembers where to come back to. */
    account: (accountId: string, returnTo?: string): Promise<AccountResponse> =>
      call(accountResponseSchema, '/api/partner/account', { method: 'GET', account: accountId, query: { return_to: returnTo } }),
  };
}
export type ShotvivaClient = ReturnType<typeof createShotvivaClient>;
