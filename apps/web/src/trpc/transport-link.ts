/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { httpBatchLink, httpLink, splitLink, type HTTPHeaders, type TRPCLink } from '@trpc/client';
import type { AppRouter } from '@repo/api/src/root';
import { trpcLinkKind } from '@/trpc/link-routing';

/** What every way of sending needs: the address, the login header, the largest batch the proxy accepts (and, in tests, the fetch to use). */
export type TransportOptions = {
  url: string;
  maxItems: number;
  headers: () => HTTPHeaders | Promise<HTTPHeaders>;
  fetch?: typeof fetch;
};

/**
 * How a call reaches /api/trpc (link-routing.ts decides which way): on its own, in the batch of slow reads, or in the
 * shared batch. The two batches are separate requests, so the shared one no longer waits for the slow reads.
 * Every way uses the same options.
 */
export function transportLink(options: TransportOptions): TRPCLink<AppRouter> {
  const { url, maxItems, headers, fetch } = options;
  const single = { url, headers, ...(fetch ? { fetch } : {}) };
  const batch = { ...single, maxItems };
  return splitLink({
    condition: op => trpcLinkKind(op.path) === 'single',
    true: httpLink(single),
    false: splitLink({
      condition: op => trpcLinkKind(op.path) === 'slow',
      true: httpBatchLink(batch),
      false: httpBatchLink(batch),
    }),
  });
}
