-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- Benchmark discovery screens every candidate author with one paid profile lookup. On staging 85% of TikHub's ~1,432 calls were these
-- lookups and 40% of them repeated an account an earlier search had already read (the dedup only holds inside one search). This table is
-- the shared cache: one row per platform + lookup kind + account, the supplier's profile item and when the supplier answered. A lookup
-- is skipped when a row is younger than 24 hours, for any user and any search; a skipped lookup is no call, so nobody is charged for it.
-- New table, not research_operations: operations have no account index, and an index there adds a lock to every research close
-- (the turn lock budget has no room: mentor-research-close sits exactly at its baseline); they also belong to one user and one erasure.
-- This table holds public third-party profile data only: no actor, session or turn id, nothing to erase with an account.
-- Written and read by the API in two batched calls per search, outside the turn's close transaction.
-- Compatible: a new table and two new functions; nothing existing changes. Repeatable. Recovery: drop the two functions and the table.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.research_profile_cache (
  platform text NOT NULL CHECK (platform ~ '^[a-z]{1,20}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,30}$'),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 200),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object' AND octet_length(profile::text)<=8192),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (platform, kind, account_key)
);
ALTER TABLE public.research_profile_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_profile_cache FROM PUBLIC,anon,authenticated,service_role;

-- The cached profiles younger than p_max_age_seconds for these accounts (at most 100 per call): [{account, profile, fetchedAt}].
CREATE OR REPLACE FUNCTION public.research_profile_cache_read(p_platform text, p_kind text, p_accounts text[], p_max_age_seconds integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object('account', c.account_key, 'profile', c.profile, 'fetchedAt', c.fetched_at)), '[]'::jsonb)
  FROM research_profile_cache c
  WHERE c.platform = p_platform AND c.kind = p_kind
    AND c.account_key IN (SELECT a FROM unnest(p_accounts) a LIMIT 100)
    AND c.fetched_at > now() - make_interval(secs => least(greatest(coalesce(p_max_age_seconds, 0), 0), 86400))
$function$;

-- Keeps the newest answer per account: a row only moves forward in time. p_rows: [{account, profile, fetchedAt}] (at most 100 per call).
-- Rows older than a week are useless (the reader never uses them past 24 hours): a few are removed on each write so the table stays small.
CREATE OR REPLACE FUNCTION public.research_profile_cache_write(p_platform text, p_kind text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; n integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 100 THEN
    RAISE EXCEPTION 'RESEARCH_PROFILE_CACHE_INVALID' USING ERRCODE='22023';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    CONTINUE WHEN coalesce(r->>'account', '') = '' OR jsonb_typeof(r->'profile') <> 'object' OR (r->>'fetchedAt') IS NULL
      OR (r->>'fetchedAt')::timestamptz > now() + interval '5 minutes';
    INSERT INTO research_profile_cache(platform, kind, account_key, profile, fetched_at)
    VALUES (p_platform, p_kind, r->>'account', r->'profile', (r->>'fetchedAt')::timestamptz)
    ON CONFLICT (platform, kind, account_key) DO UPDATE SET profile = excluded.profile, fetched_at = excluded.fetched_at
      WHERE research_profile_cache.fetched_at < excluded.fetched_at;
    n := n + 1;
  END LOOP;
  DELETE FROM research_profile_cache WHERE (platform, kind, account_key) IN
    (SELECT platform, kind, account_key FROM research_profile_cache WHERE fetched_at < now() - interval '7 days' LIMIT 50);
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION public.research_profile_cache_read(text,text,text[],integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_profile_cache_read(text,text,text[],integer) TO service_role;
REVOKE ALL ON FUNCTION public.research_profile_cache_write(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_profile_cache_write(text,text,jsonb) TO service_role;

COMMIT;
