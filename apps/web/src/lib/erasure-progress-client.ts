/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from '@repo/api/src/root';
import type { ProgressCredential } from './erasure-progress';

// Reuse the public mutation: no login refresh, cookies, query URL input, retry or mutation cache.
const client = createTRPCClient<AppRouter>({ links: [httpLink({
  url: '/api/trpc',
  fetch: (url, options) => fetch(url, { ...options, credentials: 'omit', cache: 'no-store' }),
})] });

export function queryErasureProgress(credential: ProgressCredential) {
  return client.account.erasureProgress.mutate(credential);
}
export type ErasureProgress = Awaited<ReturnType<typeof queryErasureProgress>>;
