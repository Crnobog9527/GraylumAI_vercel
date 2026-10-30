/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';

/*
 * CORE-PATH-V2 V2-7b: the fusion-recovery cron's step on turns (turn_fusion_recovery, 0436). A jury waiting 24 hours between
 * groups ends (the known usage, at most the fixed price; Owner 10-27); a jury whose review was deleted (its draft deleted)
 * is refunded in full; a review or compare whose turn another path closed (runtime-recovery's crash and 24-hour sweeps) ends
 * too. Stalled reviews are kicked by the existing daily backstop (kickStalledReviews), which advances turn-path reviews
 * through the jury turn. Idempotent and bounded per run; a failing item is counted and retried next run.
 */
const summary = z.object({ expired: z.number().int(), orphaned: z.number().int(), synced: z.number().int(), failed: z.number().int() });
export type FusionTurnRecovery = z.infer<typeof summary> & { success: boolean };

export async function recoverFusionTurns(admin: SupabaseClient, limit = 50): Promise<FusionTurnRecovery> {
  const result = await admin.rpc('turn_fusion_recovery', { p_limit: limit });
  if (result.error) {
    logger.warn('billing', 'turn_fusion_recovery_failed', {});
    return { success: false, expired: 0, orphaned: 0, synced: 0, failed: 0 };
  }
  const parsed = summary.parse(result.data);
  if (parsed.failed) logger.warn('billing', 'turn_fusion_recovery_items_failed', { failed: parsed.failed });
  return { ...parsed, success: parsed.failed === 0 };
}
