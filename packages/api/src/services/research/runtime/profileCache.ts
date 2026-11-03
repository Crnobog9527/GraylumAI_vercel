/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { logSwallowed } from '../../../lib/swallow';
import { redisEnvironment } from '../../redisEnvironment';

/*
 * The shared profile cache of benchmark discovery. A candidate author's paid profile lookup is skipped when any user's search read the
 * same account within PROFILE_CACHE_MAX_AGE_S: a skipped lookup is no supplier call and no charge.
 *
 * It lives in the Upstash Redis the rate limiter and the provider slots already use, not in Postgres: a turn may not read or write the
 * database between its model calls, may not update a site-wide row, and may not write research_* in mid-turn (docs/ENGINEERING.md,
 * main-path constraints). A Redis key per platform + lookup kind + account holds the supplier's profile and the time it answered, and
 * expires 24 hours after that answer. Nothing in it is worth keeping and nothing in it is a user's: public third-party profile data.
 * Every read and write is bounded by a short deadline; a cache that is unreachable, slow or broken is a miss, never a failure of the search.
 */
export const PROFILE_CACHE_MAX_AGE_S = 24 * 60 * 60;
export const PROFILE_CACHE_DEADLINE_MS = 300;
const KEY = (platform: string, kind: string, account: string) => `bench:profile:${platform}:${kind}:${encodeURIComponent(account)}`;

export interface CachedProfile { profile: { url?: string; fields: Record<string, string | number | boolean>; missing: string[] }; fetchedAt: string }
export interface ProfileCachePort {
  /** The cached profiles of these accounts (canonical, as the search names them) that are still fresh. */
  read(platform: string, kind: string, accounts: readonly string[]): Promise<Map<string, CachedProfile>>;
  write(platform: string, kind: string, rows: ReadonlyArray<{ account: string } & CachedProfile>): Promise<void>;
}

const profileItem = z.object({ url: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  missing: z.array(z.string()) });
const stored = z.object({ profile: profileItem, fetchedAt: z.string() });

/** The part of the Upstash client this cache uses (a test passes a double). */
export type ProfileRedis = Pick<Redis, 'mget' | 'set'>;

export function redisProfileCache(redis: ProfileRedis, now: () => number = Date.now): ProfileCachePort {
  const within = <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PROFILE_CACHE_TIMEOUT')), PROFILE_CACHE_DEADLINE_MS);
    })]).finally(() => clearTimeout(timer));
  };
  return {
    async read(platform, kind, accounts) {
      const found = new Map<string, CachedProfile>();
      if (!accounts.length) return found;
      try {
        const values = await within(redis.mget<unknown[]>(...accounts.map(account => KEY(platform, kind, account))));
        accounts.forEach((account, i) => {
          const parsed = stored.safeParse(values[i]);
          const at = parsed.success ? Date.parse(parsed.data.fetchedAt) : NaN;
          // The key expires on its own; the age is checked again so a late expiry never serves a stale profile.
          if (parsed.success && Number.isFinite(at) && now() - at < PROFILE_CACHE_MAX_AGE_S * 1000 && at <= now() + 60_000) found.set(account, parsed.data);
        });
      } catch (error) { logSwallowed('research_profile_cache_read_failed', error, { category: 'api' }); found.clear(); }
      return found;
    },
    async write(platform, kind, rows) {
      // One deadline for the whole batch: the sets go out together, so a slow Redis costs the search at most one deadline.
      const sets = rows.flatMap(row => {
        const left = PROFILE_CACHE_MAX_AGE_S - Math.floor((now() - Date.parse(row.fetchedAt)) / 1000);
        return Number.isFinite(left) && left >= 1          // a profile already past its 24 hours is not kept
          ? [redis.set(KEY(platform, kind, row.account), { profile: row.profile, fetchedAt: row.fetchedAt }, { ex: left })] : [];
      });
      try { await within(Promise.all(sets)); }
      catch (error) { logSwallowed('research_profile_cache_write_failed', error, { category: 'api' }); }
    },
  };
}

let shared: Redis | null = null;
/** The production cache on the shared Redis, or null when Redis is not configured (then every profile is looked up). */
export function sharedProfileCache(): ProfileCachePort | null {
  try {
    shared ??= (() => {
      const { url, token } = redisEnvironment(process.env);
      return new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(PROFILE_CACHE_DEADLINE_MS) });
    })();
    return redisProfileCache(shared);
  } catch (error) {
    logSwallowed('research_profile_cache_unavailable', error, { category: 'api' });
    return null;
  }
}
