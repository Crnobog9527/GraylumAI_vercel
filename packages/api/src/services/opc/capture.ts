/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const capturePendingInput = z.object({ draftId: z.string().uuid() }).strict();
export const captureResolveInput = capturePendingInput.extend({
  requestId: z.string().uuid(), stepId: z.string().min(1).max(64), fieldId: z.string().min(1).max(64),
  executionId: z.string().uuid(), hash: z.string().min(1).max(128), action: z.enum(['accept', 'ignore', 'dismiss']),
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
