/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Long-running turns: their events stream back as they happen. */
const STREAMED = new Set(['runtime.executeStream', 'runtime.resumeStream', 'opc.mentorTurnStream']);

/**
 * Reads sent on their own instead of in the shared batch. A batched response
 * waits for its slowest call: `runtime.view` takes several seconds on staging
 * while a turn is running and is polled every 2 s, and the sidebar's
 * conversation list ("正在读取对话记录…") should not wait for it.
 */
const UNBATCHED = new Set(['runtime.view', 'opc.conversations']);

export type TrpcLinkKind = 'stream' | 'single' | 'batch';

export function trpcLinkKind(path: string): TrpcLinkKind {
  if (STREAMED.has(path)) return 'stream';
  if (UNBATCHED.has(path)) return 'single';
  return 'batch';
}
