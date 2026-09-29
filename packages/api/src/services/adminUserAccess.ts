/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Explicit admin projections and audit writes matching the service_role column grants (0144).
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../lib/logger';

// last_login_at / last_ip have no writer and are not granted to service_role.
export const ADMIN_PROFILE_COLUMNS =
  'id, email, nickname, avatar_url, role, status, membership_level, credits, is_deleted, created_at';
export const ADMIN_PROFILE_LIST_COLUMNS =
  'id, email, nickname, avatar_url, role, status, membership_level, credits, created_at';
// Single literals keep supabase-js row typing (a concatenated string types rows as errors).
export const ADMIN_TRANSACTION_COLUMNS =
  'id, user_id, amount, type, description, balance_before, balance_after, ledger_type, reason_code, source_type, created_at';
export const ADMIN_ACTIVITY_COLUMNS = 'id, user_id, admin_id, action, action_type, details, created_at';
// Column hints stay valid regardless of the environment's foreign-key constraint names.
export const ADMIN_ACTIVITY_WITH_PROFILES = 'id, user_id, admin_id, action, action_type, details, created_at, '
  + 'user:profiles!user_id(id, email, nickname, avatar_url), admin:profiles!admin_id(id, email, nickname, avatar_url)';

export function withUnrecordedLoginFields<T extends object>(profile: T) {
  return { ...profile, last_login_at: null, last_ip: null };
}

export type AdminActivityEntry = {
  user_id: string;
  admin_id: string;
  action: string;
  action_type: 'status_change' | 'role_change' | 'membership_change' | 'credit_adjustment';
  details: Record<string, unknown>;
};

/**
 * Best-effort audit record written after the primary admin action succeeded.
 * A failure is logged and never retried by repeating the primary action.
 */
export async function recordAdminActivity(
  client: SupabaseClient<any, 'public', any>,
  entry: AdminActivityEntry,
) {
  const { error } = await client.from('user_activity_logs').insert(entry);
  if (error) {
    logger.error('security', 'admin_activity_log_write_failed', {
      actionType: entry.action_type,
      code: error.code ?? null,
    });
  }
}
