/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAuthUrl, getAccount, type AuthUrlInput, type ClientDeps, type PostForMePlatform } from './postForMe/client';

/**
 * PUBLISH-MONITOR connect flow (plan §4.1, migration 0246): start an attempt, record a callback with facts the
 * server fetched itself, and confirm the account the user picked. Routes and the confirmation page are PR-2b-2.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// Brand accounts (opc_accounts.platform) are connectable only when their platform name is exactly the provider's,
// so the stored connection, the brand account and the provider record always agree without a translation table.
const PROVIDER_PLATFORMS: readonly PostForMePlatform[] = ['x', 'youtube', 'tiktok', 'tiktok_business', 'instagram',
  'facebook', 'threads', 'linkedin', 'pinterest', 'bluesky'];
export function providerPlatform(brandPlatform: string): PostForMePlatform | null {
  return (PROVIDER_PLATFORMS as readonly string[]).includes(brandPlatform) ? brandPlatform as PostForMePlatform : null;
}

export type ConnectErrorCode = 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' | 'PUBLISH_MONITOR_PLATFORM_UNSUPPORTED'
  | 'PUBLISH_MONITOR_REQUEST_INVALID' | 'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE' | 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE'
  | 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED' | 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_PROVIDER_BUSY'
  | 'PUBLISH_MONITOR_PROVIDER_UNAVAILABLE' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class ConnectError extends Error {
  constructor(readonly code: ConnectErrorCode, readonly retryAfterSeconds?: number) { super(code); }
}
const KNOWN: ConnectErrorCode[] = ['PUBLISH_MONITOR_ACCOUNT_NOT_FOUND', 'PUBLISH_MONITOR_REQUEST_INVALID',
  'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE', 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE',
  'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED', 'PUBLISH_MONITOR_ACCOUNT_CLOSED'];
function dbFailure(error: { message?: string } | null | undefined): ConnectError {
  return new ConnectError(KNOWN.find(code => error?.message?.includes(code)) ?? 'PUBLISH_MONITOR_UNAVAILABLE');
}

const startSchema = z.object({ requestId: uuid, externalId: z.string(), platform: z.string(),
  permissions: z.array(z.enum(['feeds', 'posts'])) }).strict();
const callbackSchema = z.object({ requestId: uuid, platform: z.string(), newAccounts: z.array(providerId),
  ownExisting: z.array(providerId), quarantined: z.array(providerId), ignored: z.array(providerId) }).strict();
const confirmSchema = z.object({ connectionId: uuid, unselected: z.array(providerId) }).strict();

export type StartInput = { accountProjectId: string; publish: boolean;
  connectionType?: AuthUrlInput['connectionType']; bluesky?: AuthUrlInput['bluesky'] };

/** Writes the attempt first (so a replayed or lost callback can always be matched), then asks for the link. */
export async function startConnect(db: Rpc, client: ClientDeps, profileId: string, input: StartInput) {
  const started = await db.rpc('publish_monitor_connect_start', { a: uuid.parse(profileId),
    p_account_project_id: uuid.parse(input.accountProjectId), p_permissions: input.publish ? ['feeds', 'posts'] : ['feeds'] });
  if (started.error) throw dbFailure(started.error);
  const attempt = startSchema.safeParse(started.data);
  if (!attempt.success) throw dbFailure(null);
  const platform = providerPlatform(attempt.data.platform);
  if (!platform) throw new ConnectError('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
  const link = await createAuthUrl(client, { platform, externalId: attempt.data.externalId,
    permissions: attempt.data.permissions, forceReauth: input.publish, connectionType: input.connectionType,
    bluesky: input.bluesky });
  if (link.kind === 'rate_limited') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_BUSY', link.retryAfterSeconds);
  if (link.kind !== 'ok') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE');
  return { requestId: attempt.data.requestId, ...link.value };
}

/**
 * Callback query parameters are only hints: every account is re-read from the provider and its current
 * external_id and platform are what the database compares (plan §4.1, principle 3).
 */
export async function recordCallback(db: Rpc, client: ClientDeps, profileId: string, requestId: string,
  hintedAccountIds: string[]) {
  const ids = [...new Set(hintedAccountIds)].filter(id => providerId.safeParse(id).success).slice(0, 200);
  const candidates = [];
  for (const id of ids) {
    const account = await getAccount(client, id);
    if (account.kind === 'rate_limited') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_BUSY', account.retryAfterSeconds);
    if (account.kind === 'rejected') continue;
    if (account.kind !== 'ok') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE');
    candidates.push({ providerAccountId: account.value.id, platform: account.value.platform,
      externalId: account.value.externalId });
  }
  const result = await db.rpc('publish_monitor_connect_callback', { a: uuid.parse(profileId),
    p_request_id: uuid.parse(requestId), p_candidates: candidates });
  if (result.error) throw dbFailure(result.error);
  const parsed = callbackSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  return parsed.data;
}

export async function confirmConnect(db: Rpc, profileId: string, requestId: string, providerAccountId: string,
  autoTrack: boolean) {
  const result = await db.rpc('publish_monitor_connect_confirm', { a: uuid.parse(profileId),
    p_request_id: uuid.parse(requestId), p_provider_account_id: providerId.parse(providerAccountId),
    p_auto_track: autoTrack });
  if (result.error) throw dbFailure(result.error);
  const parsed = confirmSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  return parsed.data;
}
