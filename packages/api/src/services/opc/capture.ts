/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';

export const capturePendingInput = z.object({ draftId: z.string().uuid() }).strict();
export const captureResolveInput = capturePendingInput.extend({
  requestId: z.string().uuid(), stepId: z.string().min(1).max(64), fieldId: z.string().min(1).max(64),
  executionId: z.string().uuid(), hash: z.string().min(1).max(128), action: z.enum(['accept', 'ignore']),
  expectedVersion: z.number().int().nonnegative(),
}).strict();
const batchResult = z.object({
  processed: z.array(z.object({ executionId: z.string().uuid(), result: z.string() })),
  remaining: z.number().int().nonnegative(), hasMore: z.boolean(),
});
export type CaptureRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
/** Four committed batches maximum. Never invokes admission, billing or a model. */
export async function capturePending(rpc: CaptureRpc, draftId: string) {
  const processed: z.infer<typeof batchResult>['processed'] = [];
  for (let batch = 0; batch < 4; batch++) {
    const result = batchResult.parse(await rpc('opc_capture_apply', {
      p_draft_id: draftId, p_execution_id: null,
    }));
    processed.push(...result.processed);
    if (!result.hasMore || batch === 3) return { ...result, processed };
  }
  throw new Error('OPC_CAPTURE_PENDING');
}
/** Completion is already durable. Failure here must never mask its recovery. */
export async function captureCompleted(admin: SupabaseClient, actorId: string, executionId: string) {
  try {
    const result = await admin.rpc('opc_capture_apply', {
      p_actor_id: actorId, p_draft_id: null, p_execution_id: executionId,
    }).abortSignal(AbortSignal.timeout(1000));
    // Ordinary Runtime sessions have no OPC draft; SQL refuses without writing.
    if (result.error?.message === 'OPC_CAPTURE_DENIED') return;
    if (result.error) throw result.error;
  } catch {
    logger.warn('api', 'Capture deferred to next read or admission');
  }
}
