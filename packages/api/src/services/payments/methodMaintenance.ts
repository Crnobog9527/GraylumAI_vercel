/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
/** Existing authenticated annual-release cron; no new scheduler or provider calls. */
export async function releaseMethodMembershipCredits(db: Pick<SupabaseClient, 'rpc'>) {
  const released = await db.rpc('pay_waffo_release_due', { p_limit: 100 });
  if (released.error || !Number.isSafeInteger(released.data) || released.data < 0) throw new Error('PAY_WAFFO_RELEASE_UNAVAILABLE');
  // 0243: ended wallet/Waffo/Stripe terms lower the cached level so the account shows and can buy as free.
  const settled = await db.rpc('pay_common_settle_membership_levels', { p_limit: 100 });
  if (settled.error || !Number.isSafeInteger(settled.data) || settled.data < 0) throw new Error('PAY_COMMON_SETTLE_UNAVAILABLE');
  return { releasedCredits: released.data as number, settledMembershipLevels: settled.data as number };
}
