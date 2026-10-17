-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-5 follow-up: the user's own read of the session benchmark table, with the evidence refs of every
-- number (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.4: each number shows its source).
-- Number 0291 assigned by the controller (2026-10-17).
--   * research_user_benchmarks(a,s): same rows, same ownership check and the same live-answer filter as
--     research_benchmark_table (0268), plus the stored `refs` per number. Read only; nothing is written.
--     research_benchmark_rows / research_benchmark_table stay untouched: their output is what a report freezes.
--   * Returns only what the table shows: numbers, category, qualified flag, exclusion reason, fetch time and the refs
--     of the five displayed numbers. No cost, no operation ids of other kinds, no raw evidence.
-- service_role only (the web API calls it with the authenticated profile id).
-- Recovery: forward only. DROP FUNCTION public.research_user_benchmarks(uuid,uuid) withdraws it; no data is touched.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.research_user_benchmarks(a uuid, s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE output jsonb;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'fetchedAt',b.fetched_at,
    'refs',jsonb_build_object('followers',coalesce(b.refs->'followers','[]'::jsonb),
      'medianViews',coalesce(b.refs->'medianViews','[]'::jsonb),
      'engagementRate',coalesce(b.refs->'engagementRate','[]'::jsonb),
      'postsPerWeek',coalesce(b.refs->'postsPerWeek','[]'::jsonb),
      'lastPublishedAt',coalesce(b.refs->'lastPublishedAt','[]'::jsonb)))
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb) INTO output
  FROM (SELECT b.* FROM research_benchmarks b
    JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE b.actor_id=a AND b.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN output;
END $$;
REVOKE ALL ON FUNCTION public.research_user_benchmarks(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.research_user_benchmarks(uuid,uuid) TO service_role;

COMMIT;
