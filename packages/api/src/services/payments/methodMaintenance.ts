/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
/** Existing authenticated annual-release cron; no new scheduler or provider calls. */
export async function releaseMethodMembershipCredits(db: Pick<SupabaseClient, 'rpc'>) {
  const released = await db.rpc('pay_waffo_release_due', { p_limit: 100 });
  if (released.error || !Number.isSafeInteger(released.data) || released.data < 0) throw new Error('PAY_WAFFO_RELEASE_UNAVAILABLE');
  return { releasedCredits: released.data as number };
}
