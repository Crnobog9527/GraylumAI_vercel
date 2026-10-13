/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VendorDeps, VendorRequest } from './types';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type VendorExchange =
  | { kind: 'response'; status: number; json: unknown }
  /** The supplier answered but the body was unreadable or too large; it may still charge. */
  | { kind: 'unreadable'; status: number; reason: 'RESPONSE_TOO_LARGE' | 'RESPONSE_NOT_JSON' | 'RESPONSE_EMPTY' }
  /** No answer: the request may or may not have reached the supplier. */
  | { kind: 'unknown'; reason: 'TIMEOUT' | 'NETWORK_ERROR' };

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * One request, never retried here. Errors after `fetch` starts are reported as unknown because
 * the supplier may already have accepted (and billed) the request.
 */
export async function exchange(
  request: VendorRequest, headers: Record<string, string>, deps: VendorDeps,
): Promise<VendorExchange> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const init: RequestInit = { method: request.method, headers: { Accept: 'application/json', ...headers }, signal: controller.signal };
    if (request.body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(request.body);
    }
    const response = await fetchImpl(request.url, init);
    const body = await readCapped(response, MAX_RESPONSE_BYTES);
    if (body === null) return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_TOO_LARGE' };
    if (body.trim() === '') return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_EMPTY' };
    try {
      return { kind: 'response', status: response.status, json: JSON.parse(body) };
    } catch {
      return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_NOT_JSON' };
    }
  } catch {
    return { kind: 'unknown', reason: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/;

/** Non-negative decimal string for official usage; null for anything negative, non-finite or malformed. */
export function usageUnits(value: unknown): string | null {
  const textValue = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof textValue === 'string' && DECIMAL.test(textValue) ? textValue : null;
}

/** Non-public targets. IPv6 literals are refused outright (mapped, unspecified, ULA, link-local, ...). */
export function nonPublicHost(hostname: string): boolean {
  // `localhost.` and `foo.internal.` are the same hosts as without the DNS root dot.
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') || host.includes(':')) return true;
  // IANA special-use and common private suffixes: never public pages.
  const special = ['localhost', 'local', 'internal', 'arpa', 'test', 'invalid', 'example', 'onion', 'lan', 'home', 'corp', 'intranet', 'private', 'alt'];
  if (special.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (!host.includes('.')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  const c = Number(v4[3]);
  // IANA special-purpose blocks that are not globally reachable (plus multicast and reserved 224/3).
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || (a === 192 && b === 88 && c === 99);
}
