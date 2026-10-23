/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PUBLISH_MONITOR_SWITCH } from './foundation';
import { REVIEW_SWITCH } from './reviewSettings';

/**
 * PUBLISH-MONITOR PR-7: which launched capabilities the paywall, pricing page and workspace rail may name (plan §9
 * "付费墙和价格页的功能行跟随后台开关"). Only the two admin switches, as booleans; a read failure means "not shown".
 * One-click publishing is not here: it has no page yet and stays unnamed until each platform passes (plan §9 item 8).
 */
export type PublicPublishMonitorFeatures = { ownData: boolean; weeklyReview: boolean };
export const NO_PUBLIC_FEATURES: PublicPublishMonitorFeatures = { ownData: false, weeklyReview: false };

export async function readPublicFeatures(db: Pick<SupabaseClient, 'from'>): Promise<PublicPublishMonitorFeatures> {
  try {
    const { data, error } = await db.from('system_settings').select('key,value')
      .in('key', [PUBLISH_MONITOR_SWITCH, REVIEW_SWITCH]);
    if (error || !Array.isArray(data)) return NO_PUBLIC_FEATURES;
    const on = (key: string) => data.some(row => row.key === key && row.value === true);
    const ownData = on(PUBLISH_MONITOR_SWITCH);
    return { ownData, weeklyReview: ownData && on(REVIEW_SWITCH) };
  } catch {
    return NO_PUBLIC_FEATURES;
  }
}
