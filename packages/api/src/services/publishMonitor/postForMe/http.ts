/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Post for Me transport. Same shape as the RESEARCH-TOOLS vendor exchange (#923, not merged yet):
// one request, a size cap, a timeout, and "unknown" whenever the request may have reached the provider.
export const POSTFORME_BASE_URL = 'https://api.postforme.dev/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;
export type PostForMeExchange =
  | { kind: 'response'; status: number; json: unknown; retryAfterSeconds: number | null }
  | { kind: 'unreadable'; status: number; reason: 'RESPONSE_TOO_LARGE' | 'RESPONSE_NOT_JSON' | 'RESPONSE_EMPTY' }
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

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw || !/^\d{1,4}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** One request, never retried here. The API key is passed in and never logged or returned. */
export async function exchange(request: { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown },
  apiKey: string, deps: { fetchImpl?: FetchImpl; timeoutMs?: number } = {}): Promise<PostForMeExchange> {
  if (!request.path.startsWith('/') || request.path.includes('..') || request.path.includes('//')) {
    throw new Error('POSTFORME_PATH_INVALID');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    const init: RequestInit = { method: request.method, headers, signal: controller.signal, redirect: 'error' };
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    const response = await fetchImpl(`${POSTFORME_BASE_URL}${request.path}`, init);
    const body = await readCapped(response, MAX_RESPONSE_BYTES);
    if (body === null) return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_TOO_LARGE' };
    if (body.trim() === '') return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_EMPTY' };
    try {
      return { kind: 'response', status: response.status, json: JSON.parse(body), retryAfterSeconds: retryAfter(response) };
    } catch {
      return { kind: 'unreadable', status: response.status, reason: 'RESPONSE_NOT_JSON' };
    }
  } catch {
    return { kind: 'unknown', reason: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/** Non-public hosts. IPv6 literals are refused outright (mapped, unspecified, ULA, link-local, ...). */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') || host.includes(':')) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (!host.includes('.')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || (a === 192 && b === 88 && c === 99);
}

/**
 * A provider-supplied link we may store or show: absolute https on a public host, no credentials.
 * Anything else is dropped (treated as "not provided"), never followed by the server.
 */
export function publicHttpsUrl(value: unknown, maxLength = 2048): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password || privateHost(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
