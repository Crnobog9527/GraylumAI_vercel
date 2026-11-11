/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../../lib/logger';

/**
 * The way out of a metering block (deep review 2026-11-11, finding 10). A model receipt whose cost went above the bound frozen for it
 * is marked budget_conflict (turn_call_record), and turn_call_begin then refuses every user's call to that model
 * (TURN_MODEL_METERING_BLOCKED) until an administrator has checked its price. admin_metering_blocks lists the models held this way;
 * admin_metering_review is the admin action that lets one through again (it changes no price and no charge; once, audit-logged).
 * Both are SECURITY DEFINER functions for the service role (migration turn_metering_block_review).
 */
const usd = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const blocks = z.array(z.object({ modelId: z.string().uuid(), model: z.string().nullable(), calls: z.number().int().positive(),
  firstAt: z.string().nullable(), lastAt: z.string().nullable(), turnId: z.number().int(), upperUsd: usd,
  nominalUsd: usd.nullable(), actualUsd: usd.nullable() }).strict()).max(500);
const reviewed = z.object({ modelId: z.string().uuid(), reviewed: z.number().int().nonnegative() }).strict();
export type MeteringBlock = z.infer<typeof blocks>[number];

/** The models off for every user right now. A list that cannot be read is unavailable, never "none". */
export async function meteringBlocks(supabase: Pick<SupabaseClient, 'rpc'>) {
  const { data, error } = await supabase.rpc('admin_metering_blocks');
  const parsed = blocks.safeParse(data);
  if (error || !parsed.success) {
    logger.warn('billing', 'metering_blocks_unavailable', { code: error?.code ?? 'invalid_shape' });
    return { available: false as const };
  }
  return { available: true as const, blocks: parsed.data };
}

export class MeteringReviewError extends Error {
  constructor(readonly code: 'TURN_ADMIN_DENIED' | 'TURN_METERING_REVIEW_FAILED') { super(code); }
}

/** The admin action "已核对价格，恢复调用". `reviewed` 0: nothing was held any more (a repeat, or another admin was first). */
export async function reviewMeteringBlock(supabase: Pick<SupabaseClient, 'rpc'>,
  input: { modelId: string; adminId: string; requestId: string }) {
  const { data, error } = await supabase.rpc('admin_metering_review', { p_model_id: input.modelId, p_admin_id: input.adminId,
    p_request_id: input.requestId });
  if (error) {
    const denied = (error.message ?? '').includes('TURN_ADMIN_DENIED');
    logger.warn('billing', 'metering_review_failed', { code: denied ? 'TURN_ADMIN_DENIED' : error.code ?? 'unknown' });
    throw new MeteringReviewError(denied ? 'TURN_ADMIN_DENIED' : 'TURN_METERING_REVIEW_FAILED');
  }
  const parsed = reviewed.safeParse(data);
  if (!parsed.success) throw new MeteringReviewError('TURN_METERING_REVIEW_FAILED');
  // The model is on again for everyone: on record with who did it (the audit row has the same request id).
  if (parsed.data.reviewed > 0) logger.info('billing', 'metering_block_reviewed', { modelId: input.modelId, calls: parsed.data.reviewed });
  return parsed.data;
}
