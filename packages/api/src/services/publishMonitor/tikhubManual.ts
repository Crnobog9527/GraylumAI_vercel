/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BilledReadDeps } from './billedRead';
import { call, type refreshInput } from './data';
import { tikhubClaimSchema } from './tikhub';
import { readTikhubClaim } from './tikhubRefresh';

const uuid = z.string().uuid();
export type TikhubReadResult = { outcome: 'read' | 'not_fetched' | 'insufficient_credits' | 'unavailable' };
const TIKHUB_LEASE_SECONDS = 300;

/**
 * VOICE-2 "读取最新帖子" (Owner 2026-11-14 "加按钮，按用量扣"): one manual run of the daily TikHub read of an own connection —
 * the same billed read and settle (readTikhubClaim), so it is charged by what came back and nothing for a failure. Once an
 * hour per connection; a read that could not start or ran out of balance gives the hour back.
 */
export async function manualTikhubRead(db: SupabaseClient, deps: Omit<BilledReadDeps, 'admin'>, profileId: string,
  input: z.infer<typeof refreshInput>): Promise<TikhubReadResult> {
  const a = uuid.parse(profileId);
  const claim = await call(db, 'publish_monitor_tikhub_request', { a, p_connection_id: input.connectionId,
    p_lease_seconds: TIKHUB_LEASE_SECONDS }, tikhubClaimSchema);
  const read = await readTikhubClaim(db, deps, claim, () => call(db, 'publish_monitor_tikhub_request_undo', { a,
    p_connection_id: claim.connectionId, p_lease: claim.lease, p_refresh_id: claim.refreshId }, z.boolean()));
  if (read.outcome === 'insufficient_credits' || read.outcome === 'unavailable') return { outcome: read.outcome };
  return { outcome: read.fetched ? 'read' : 'not_fetched' };
}
