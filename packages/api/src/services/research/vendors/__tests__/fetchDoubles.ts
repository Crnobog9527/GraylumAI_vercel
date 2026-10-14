/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Test-only fetch doubles for the research adapters. No test ever reaches a real supplier.

export interface RecordedCall { url: string; init: RequestInit }

export function jsonFetch(status: number, body: unknown, calls: RecordedCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

export function failingFetch(error: Error = new TypeError('fetch failed'), calls: RecordedCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    throw error;
  }) as typeof fetch;
}

/** Never answers until aborted, like a supplier that hangs after accepting the request. */
export function hangingFetch(calls: RecordedCall[] = []): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch;
}

export const FIXED_NOW = () => new Date('2026-10-13T00:00:00.000Z');
