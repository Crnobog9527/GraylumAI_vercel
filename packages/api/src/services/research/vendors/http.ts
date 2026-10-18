/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { VendorDeps, VendorRequest } from './types';

export const DEFAULT_TIMEOUT_MS = 60_000;
// Real TikTok keyword searches answer with 1.7-2.3 MB of JSON (RT-7 sampling, 2026-10-18), so the cap is 8 MiB.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
    // Never follow redirects: a 3xx from a supplier API would otherwise carry our API key header to another host.
    const init: RequestInit = {
      method: request.method, headers: { Accept: 'application/json', ...headers }, signal: controller.signal, redirect: 'manual',
    };
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
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? nonPublicIpv4(host) : false;
}

/** IANA special-purpose IPv4 blocks that are not globally reachable (plus multicast and reserved 224/3). */
function nonPublicIpv4(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || (a === 192 && b === 88 && c === 99);
}

/** A result link the user can open: trimmed, absolute http(s), no credentials, public host. */
export function publicHttpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !nonPublicHost(url.hostname)
      ? url.href : undefined;
  } catch { return undefined; }
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not plain hexadecimal IPv6. */
function ipv6Groups(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return all.map(group => parseInt(group, 16));
}

/**
 * Resolved addresses: an allowlist. IPv4 must be outside the special-purpose blocks; IPv6 must be global
 * unicast 2000::/3 and outside 2001::/23 (incl. Teredo, benchmarking), 2001:db8::/32, 2002::/16 (6to4),
 * 3fff::/20 (documentation) and 2620:4f:8000::/48. IPv4-mapped IPv6 is judged by its IPv4 part.
 */
export function nonPublicIp(address: string): boolean {
  const ip = address.toLowerCase();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return nonPublicIpv4(mapped[1]);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return nonPublicIpv4(ip);
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g[0] < 0x2000 || g[0] > 0x3fff) return true;
  if (g[0] === 0x2001 && (g[1] < 0x0200 || g[1] === 0x0db8)) return true;
  if (g[0] === 0x2002 || (g[0] === 0x3fff && g[1] < 0x1000)) return true;
  return g[0] === 0x2620 && g[1] === 0x004f && g[2] === 0x8000;
}

/** Status codes after which the supplier may already have billed: any 2xx, and 5xx where billing is undocumented. */
export function mayHaveBilled(status: number, undocumented5xx: boolean): boolean {
  return (status >= 200 && status < 300) || (undocumented5xx && status >= 500);
}
