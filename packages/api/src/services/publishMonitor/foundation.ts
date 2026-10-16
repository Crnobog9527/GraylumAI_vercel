/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * PUBLISH-MONITOR PR-1 (migration 0240): the user's own monitoring settings and connection overview.
 * Only service-role RPCs touch the social_* tables; nothing here calls Post for Me or TikHub.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
const uuid = z.string().uuid();
const timestamp = z.string().min(1).nullable();

export const PUBLISH_MONITOR_SWITCH = 'publish_monitor_enabled';

const settingsSchema = z.object({
  autoReviewEnabled: z.boolean(), autoReviewEnabledAt: timestamp,
}).strict();
export type PublishMonitorSettings = z.infer<typeof settingsSchema>;

const connectionSchema = z.object({
  id: uuid, businessId: uuid, accountProjectId: uuid.nullable(),
  role: z.enum(['own', 'benchmark']), source: z.enum(['postforme', 'tikhub', 'manual']),
  platform: z.string().regex(/^[a-z0-9_-]{1,32}$/), displayHint: z.string().nullable(),
  status: z.enum(['connected', 'reauth_required', 'quarantined', 'disconnected']),
  consentRead: z.boolean(), consentAutoTrack: z.boolean(), consentPublish: z.boolean(),
  lastSuccessAt: timestamp, postCount: z.number().int().nonnegative(),
}).strict();
export type PublishMonitorConnection = z.infer<typeof connectionSchema>;

export const autoReviewInput = z.object({ enabled: z.boolean() }).strict();

export type PublishMonitorErrorCode = 'PUBLISH_MONITOR_DISABLED' | 'PUBLISH_MONITOR_ACCOUNT_CLOSED'
  | 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class PublishMonitorError extends Error {
  constructor(readonly code: PublishMonitorErrorCode) { super(code); }
}
function failure(error: { message?: string } | null | undefined): PublishMonitorError {
  const known = (['PUBLISH_MONITOR_ACCOUNT_CLOSED', 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND'] as const)
    .find(code => error?.message?.includes(code));
  return new PublishMonitorError(known ?? 'PUBLISH_MONITOR_UNAVAILABLE');
}

/** The feature stays off until an admin explicitly enables it; a missing or malformed value means off. */
export async function assertPublishMonitorEnabled(db: Pick<SupabaseClient, 'from'>): Promise<void> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', PUBLISH_MONITOR_SWITCH)
    .maybeSingle();
  if (error) throw failure(null);
  if (data?.value !== true) throw new PublishMonitorError('PUBLISH_MONITOR_DISABLED');
}

export async function readPublishMonitorSettings(db: Rpc, profileId: string): Promise<PublishMonitorSettings> {
  const result = await db.rpc('publish_monitor_settings', { a: uuid.parse(profileId) });
  if (result.error) throw failure(result.error);
  const parsed = settingsSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

export async function setAutoReview(db: Rpc, profileId: string,
  input: z.infer<typeof autoReviewInput>): Promise<PublishMonitorSettings> {
  const { enabled } = autoReviewInput.parse(input);
  const result = await db.rpc('publish_monitor_set_auto_review', { a: uuid.parse(profileId), p_enabled: enabled });
  if (result.error) throw failure(result.error);
  const parsed = settingsSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

export async function listConnections(db: Db, profileId: string): Promise<PublishMonitorConnection[]> {
  const result = await db.rpc('publish_monitor_connections', { a: uuid.parse(profileId) });
  if (result.error) throw failure(result.error);
  const parsed = z.array(connectionSchema).safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

export const disconnectInput = z.object({ connectionId: uuid }).strict();

/**
 * "Disconnect and delete" (plan §4.1): the user's posts and snapshots for this connection are removed now; a Post for
 * Me connection becomes an identity-free deletion record that the daily job deletes at the provider (PR-2c).
 */
export async function disconnectConnection(db: Rpc, profileId: string, input: z.infer<typeof disconnectInput>) {
  const result = await db.rpc('publish_monitor_disconnect', { a: uuid.parse(profileId), p_connection_id: input.connectionId });
  if (result.error) throw failure(result.error);
  const parsed = z.object({ connectionId: uuid, providerCleanup: z.boolean() }).strict().safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}
