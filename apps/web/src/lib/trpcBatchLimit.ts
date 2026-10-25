/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * ARCH-FIX A1: one HTTP request may carry at most this many tRPC calls. The per-IP limit in the
 * proxy counts HTTP requests, so without a cap one request could carry any number of calls.
 * The browser client splits its batches at the same number (trpc/provider.tsx maxItems).
 */
export const TRPC_MAX_BATCH_CALLS = 10;

/** Calls named in `/api/trpc/a,b,c`. tRPC reads the comma list only for `?batch=1`; anything else is one call. */
export function trpcCallCount(pathname: string, search: URLSearchParams): number {
  if (!pathname.startsWith('/api/trpc/')) return 0;
  if (search.get('batch') !== '1') return 1;
  return pathname.slice('/api/trpc/'.length).split(',').length;
}
