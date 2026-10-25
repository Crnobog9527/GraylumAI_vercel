/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * PUBLISH-MONITOR: the Post for Me billing period's publish count (migration 0380), read for the admin page and the
 * 80% / full alerts. One count is one platform that was delivered, the same unit Post for Me bills; only numbers and the
 * period's dates leave the database.
 */
const count = z.number().int().nonnegative();
const usage = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }).strict(),
  z.object({ configured: z.literal(true), periodStart: z.string(), periodEnd: z.string(), limit: count.min(1), used: count,
    reserved: count }).strict(),
]);
export type QuotaUsage = z.infer<typeof usage>;

export async function readQuotaUsage(db: Pick<SupabaseClient, 'rpc'>): Promise<QuotaUsage> {
  const { data, error } = await db.rpc('publish_monitor_quota_usage');
  if (error) throw new Error('PUBLISH_MONITOR_QUOTA_UNAVAILABLE');
  const parsed = usage.safeParse(data);
  if (!parsed.success) throw new Error('PUBLISH_MONITOR_QUOTA_UNAVAILABLE');
  return parsed.data;
}

export type QuotaLevel = 'ok' | 'near' | 'full';
/** Held counts too: a held slot is a publish that may still be delivered (the same sum the claim checks, plan §6). */
export function quotaLevel(value: Extract<QuotaUsage, { configured: true }>): QuotaLevel {
  const total = value.used + value.reserved;
  if (total >= value.limit) return 'full';
  return total * 5 >= value.limit * 4 ? 'near' : 'ok';
}
