/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PUBLISH_MONITOR_SWITCH } from './foundation';
import { REVIEW_SWITCH } from './reviewSettings';

/**
 * PUBLISH-MONITOR PR-7: which launched capabilities the paywall, pricing page and workspace rail may name (plan §9
 * "付费墙和价格页的功能行跟随后台开关"). Only the two admin switches, as booleans; a read failure means "not shown".
 * One-click publishing has its own listing switch, off until the publishing page has passed acceptance (plan §9 item 8;
 * the controller turns it on, Owner 2026-10-23 "一键发布要做").
 */
export const PUBLISH_LISTED_SWITCH = 'publish_monitor_publish_listed';
export type PublicPublishMonitorFeatures = { ownData: boolean; weeklyReview: boolean; publish: boolean };
export const NO_PUBLIC_FEATURES: PublicPublishMonitorFeatures = { ownData: false, weeklyReview: false, publish: false };

export async function readPublicFeatures(db: Pick<SupabaseClient, 'from'>): Promise<PublicPublishMonitorFeatures> {
  try {
    const { data, error } = await db.from('system_settings').select('key,value')
      .in('key', [PUBLISH_MONITOR_SWITCH, REVIEW_SWITCH, PUBLISH_LISTED_SWITCH]);
    if (error || !Array.isArray(data)) return NO_PUBLIC_FEATURES;
    const on = (key: string) => data.some(row => row.key === key && row.value === true);
    const ownData = on(PUBLISH_MONITOR_SWITCH);
    return { ownData, weeklyReview: ownData && on(REVIEW_SWITCH), publish: ownData && on(PUBLISH_LISTED_SWITCH) };
  } catch {
    return NO_PUBLIC_FEATURES;
  }
}
