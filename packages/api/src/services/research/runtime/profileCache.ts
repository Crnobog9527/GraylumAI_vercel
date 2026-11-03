/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logSwallowed } from '../../../lib/swallow';

/*
 * The shared profile cache of benchmark discovery (0493). A candidate author's paid profile lookup is skipped when any user's search read
 * the same account within PROFILE_CACHE_MAX_AGE_S: a skipped lookup is no supplier call and no charge. Reads and writes are one batched
 * database call each, outside the turn's close transaction; a cache that cannot answer is simply a miss, never a failure of the search.
 */
export const PROFILE_CACHE_MAX_AGE_S = 24 * 60 * 60;
const BATCH = 100;

export interface CachedProfile { profile: { url?: string; fields: Record<string, string | number | boolean>; missing: string[] }; fetchedAt: string }
export interface ProfileCachePort {
  /** The cached profiles of these accounts (canonical, as the search names them) that are still fresh. */
  read(platform: string, kind: string, accounts: readonly string[]): Promise<Map<string, CachedProfile>>;
  write(platform: string, kind: string, rows: ReadonlyArray<{ account: string } & CachedProfile>): Promise<void>;
}

const profileItem = z.object({ url: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  missing: z.array(z.string()) });
const hits = z.array(z.object({ account: z.string(), profile: profileItem, fetchedAt: z.string() }));

export function profileCache(db: Pick<SupabaseClient, 'rpc'>): ProfileCachePort {
  return {
    async read(platform, kind, accounts) {
      const found = new Map<string, CachedProfile>();
      try {
        for (let i = 0; i < accounts.length; i += BATCH) {
          const { data, error } = await db.rpc('research_profile_cache_read', { p_platform: platform, p_kind: kind,
            p_accounts: accounts.slice(i, i + BATCH), p_max_age_seconds: PROFILE_CACHE_MAX_AGE_S });
          if (error) throw new Error(error.code ?? 'PROFILE_CACHE_READ_FAILED');
          for (const row of hits.parse(data)) found.set(row.account, { profile: row.profile, fetchedAt: row.fetchedAt });
        }
      } catch (error) { logSwallowed('research_profile_cache_read_failed', error, { category: 'api' }); }
      return found;
    },
    async write(platform, kind, rows) {
      try {
        for (let i = 0; i < rows.length; i += BATCH) {
          const { error } = await db.rpc('research_profile_cache_write', { p_platform: platform, p_kind: kind,
            p_rows: rows.slice(i, i + BATCH).map(row => ({ account: row.account, profile: row.profile, fetchedAt: row.fetchedAt })) });
          if (error) throw new Error(error.code ?? 'PROFILE_CACHE_WRITE_FAILED');
        }
      } catch (error) { logSwallowed('research_profile_cache_write_failed', error, { category: 'api' }); }
    },
  };
}
