/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlatformSecret, PlatformSecretError } from '../platformSecrets';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

/**
 * ADMIN-SECRETS OR-1: the one OpenRouter key, entered in the admin's third-party keys page and kept in
 * Supabase Vault (slot `openrouter`, no environment fallback). Replaces the per-model `ai_models.api_key`.
 * Undefined when the admin has not filled it; a failed database read throws PLATFORM_SECRET_UNAVAILABLE
 * (never a silent switch to another key). `fresh`: bypass the 60 s per-instance cache; every path that authorizes a
 * paid provider call uses it (a cleared or replaced key must stop working at once on every instance).
 */
export async function readOpenRouterKey(admin: RpcClient, options: { fresh?: boolean } = {}): Promise<string | undefined> {
  try {
    return (await getPlatformSecret(admin, 'openrouter', { fresh: options.fresh })).value.trim() || undefined;
  } catch (error) {
    if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return undefined;
    throw error;
  }
}

/** Whether the OpenRouter key is filled in (for availability checks; the value never leaves the server). */
export async function openRouterKeyConfigured(admin: RpcClient): Promise<boolean> {
  return (await readOpenRouterKey(admin)) !== undefined;
}

/** The account a test window quotes for a key: `openrouter-key:` + sha256 of the exact key. */
export function openRouterAccount(key: string): string {
  return 'openrouter-key:' + createHash('sha256').update(key).digest('hex');
}
