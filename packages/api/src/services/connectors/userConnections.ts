/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readOwnDataTier } from '../membershipEntitlements';

/**
 * INTEGRATION-BASE PR B1: connectors that need a credential of the user's own (the first is the Feishu Base, plan B of
 * 2026-11-14). The credential lives only in Vault, reached through four service-role functions (migration
 * 0529_user_connections.sql); the user_connections row keeps the target it is for, a label, its last four characters and
 * when the provider last rejected it. Shotviva does not use this: it has no per-user credential.
 *
 * Nothing here returns the credential to a caller other than the provider client on the server.
 */
export const USER_CONNECTION_PROVIDERS = ['feishu_base'] as const;
export type UserConnectionProvider = typeof USER_CONNECTION_PROVIDERS[number];

export type UserConnectionCode = 'CONNECTION_UNAVAILABLE' | 'CONNECTION_ACCOUNT_CLOSED' | 'CONNECTION_INPUT_INVALID'
  | 'CONNECTION_MEMBERSHIP_REQUIRED';
export class UserConnectionError extends Error {
  constructor(readonly code: UserConnectionCode) { super(code); }
}

export type UserConnection = {
  provider: UserConnectionProvider;
  /** What the credential is for, e.g. { appToken } of a Feishu Base. Never the credential. */
  target: Record<string, unknown>;
  label: string | null;
  last4: string;
  /** The provider rejected this credential; the user has to enter a new one. */
  failed: boolean;
  connectedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkIds(profileId: string, provider: string): asserts provider is UserConnectionProvider {
  if (!UUID.test(profileId) || !(USER_CONNECTION_PROVIDERS as readonly string[]).includes(provider)) {
    throw new UserConnectionError('CONNECTION_INPUT_INVALID');
  }
}

/** The database's refusal codes are in the message; anything else is "unavailable" (never the raw error). */
function fromDatabase(error: { message?: string } | null | undefined): UserConnectionError {
  const message = error?.message ?? '';
  if (message.includes('CONNECTION_ACCOUNT_CLOSED')) return new UserConnectionError('CONNECTION_ACCOUNT_CLOSED');
  if (message.includes('CONNECTION_INPUT_INVALID')) return new UserConnectionError('CONNECTION_INPUT_INVALID');
  return new UserConnectionError('CONNECTION_UNAVAILABLE');
}

/** Pro or Gold only, read live (an expired membership is free). Owner 2026-11-14: the Feishu connector is Pro/Gold only. */
const PAID_LEVELS: readonly string[] = ['pro', 'gold'];
export async function paidConnectorMember(admin: SupabaseClient, profileId: string): Promise<boolean> {
  try { return PAID_LEVELS.includes(String((await readOwnDataTier(admin, profileId))?.level)); }
  catch { throw new UserConnectionError('CONNECTION_UNAVAILABLE'); }
}

type Row = { provider: string; target: unknown; label: string | null; last4: string; failed_at: string | null; created_at: string };

export async function readUserConnection(admin: SupabaseClient, profileId: string, provider: string): Promise<UserConnection | null> {
  checkIds(profileId, provider);
  const { data, error } = await admin.from('user_connections').select('provider,target,label,last4,failed_at,created_at')
    .eq('profile_id', profileId).eq('provider', provider).maybeSingle();
  if (error) throw new UserConnectionError('CONNECTION_UNAVAILABLE');
  if (!data) return null;
  const row = data as Row;
  const target = row.target && typeof row.target === 'object' && !Array.isArray(row.target) ? row.target as Record<string, unknown> : {};
  return { provider, target, label: row.label, last4: row.last4, failed: row.failed_at !== null, connectedAt: row.created_at };
}

/** Store (or replace) the user's credential. Callers check membership and that the provider accepts it first. */
export async function saveUserConnection(admin: SupabaseClient, input: {
  profileId: string; provider: string; secret: string; target: Record<string, unknown>; label: string | null;
}): Promise<void> {
  checkIds(input.profileId, input.provider);
  const { error } = await admin.rpc('user_connection_set', { p_profile_id: input.profileId, p_provider: input.provider,
    p_secret: input.secret, p_target: input.target, p_label: input.label });
  if (error) throw fromDatabase(error);
}

/** The credential, for the provider client only; null when not connected. */
export async function readUserConnectionSecret(admin: SupabaseClient, profileId: string, provider: string): Promise<string | null> {
  checkIds(profileId, provider);
  const { data, error } = await admin.rpc('user_connection_secret', { p_profile_id: profileId, p_provider: provider });
  if (error) throw fromDatabase(error);
  return typeof data === 'string' ? data : null;
}

/** The provider rejected the credential ending in last4 (a newer one entered meanwhile is left alone). */
export async function markUserConnectionFailed(admin: SupabaseClient, profileId: string, provider: string, last4: string) {
  checkIds(profileId, provider);
  const { error } = await admin.rpc('user_connection_failed', { p_profile_id: profileId, p_provider: provider, p_last4: last4 });
  if (error) throw fromDatabase(error);
}

/** "断开": the row and its Vault entry are deleted. What was already written to the user's own Feishu stays theirs. */
export async function deleteUserConnection(admin: SupabaseClient, profileId: string, provider: string): Promise<boolean> {
  checkIds(profileId, provider);
  const { data, error } = await admin.rpc('user_connection_delete', { p_profile_id: profileId, p_provider: provider });
  if (error) throw fromDatabase(error);
  return data === true;
}
