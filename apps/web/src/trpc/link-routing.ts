/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Reads sent on their own instead of in the shared batch. A batched response
 * waits for its slowest call: `runtime.view` takes several seconds on staging
 * while a turn is running and is polled every 2 s, and the sidebar's
 * conversation list ("正在读取对话记录…") should not wait for it.
 */
const UNBATCHED = new Set(['runtime.view', 'opc.conversations']);

/**
 * Reads that are slow on the server and are not what a page shows first: the composer's model and Skill lists and the
 * compare picker's options. Measured on staging (2026-11-11, `runtime_request_timing`): these three together took 749 ms
 * and 46 database round trips, while the batch with the profile, the sidebar lists and the credit balance took 336 ms.
 * In one batch the name, the sidebar and the balance (and, on a conversation page, the conversation itself) all waited
 * for them. They go in a batch of their own: still one request for the three, sent at the same moment as the shared batch.
 */
const SLOW_READS = new Set(['runtime.choices', 'opc.catalog', 'fusionCompare.options']);

export type TrpcLinkKind = 'single' | 'slow' | 'batch';

export function trpcLinkKind(path: string): TrpcLinkKind {
  if (UNBATCHED.has(path)) return 'single';
  if (SLOW_READS.has(path)) return 'slow';
  return 'batch';
}
