/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { PublishMonitorError } from './foundation';

/**
 * PUBLISH-MONITOR: add a brand account from the data review page (migration 0347), without adopting a topic first
 * (Owner 2026-10-23). The database function owns every rule (own business, confirmed positioning, one account per
 * platform and business, replay); this layer only validates the shape and maps the refusals.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();

// Platforms a brand account can be connected for: the Post for Me platforms (TikTok Business is not opened, Owner
// 2026-10-23) and the two read through public profile links.
export const ACCOUNT_PLATFORMS = ['x', 'youtube', 'tiktok', 'instagram', 'facebook', 'threads', 'linkedin', 'pinterest',
  'bluesky', 'xiaohongshu', 'douyin'] as const;

export const addAccountInput = z.object({
  businessId: uuid,
  platform: z.enum(ACCOUNT_PLATFORMS),
  // Same rule as opc_accounts.account_key; the name is stored lower-case.
  account: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
}).strict();

const result = z.object({ accountProjectId: uuid, businessId: uuid, platform: z.string(), account: z.string(),
  created: z.boolean() }).strict();
export type AddedAccount = z.infer<typeof result>;

const KNOWN = ['PUBLISH_MONITOR_ACCOUNT_CLOSED', 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND', 'PUBLISH_MONITOR_ACCOUNT_EXISTS_ELSEWHERE',
  'PUBLISH_MONITOR_PLATFORM_HAS_ACCOUNT', 'PUBLISH_MONITOR_BUSINESS_NOT_READY'] as const;

export async function addBrandAccount(db: Rpc, profileId: string, raw: z.input<typeof addAccountInput>): Promise<AddedAccount> {
  const input = addAccountInput.parse(raw);
  const { data, error } = await db.rpc('publish_monitor_account_add', { a: uuid.parse(profileId), p_business: input.businessId,
    p_platform: input.platform, p_account: input.account });
  if (error) {
    const known = KNOWN.find(code => error.message?.includes(code));
    throw new PublishMonitorError(known ?? 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  const parsed = result.safeParse(data);
  if (!parsed.success) throw new PublishMonitorError('PUBLISH_MONITOR_UNAVAILABLE');
  return parsed.data;
}
