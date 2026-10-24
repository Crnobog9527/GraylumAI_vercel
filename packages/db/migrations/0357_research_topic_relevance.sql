-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BENCHMARK-COVERAGE topic relevance (Owner 2026-10-23, Master Plan 2.1; plan BENCHMARK_COVERAGE_PLAN §2.6): the user's
-- benchmark table shows how much of each account is on the confirmed niche, and lists the more relevant accounts first.
--   * research_user_benchmarks (0282): each row also returns `topicRelevance`, the 0–1 share benchmark_fetch computed by
--     code from the account's fetched post titles against the session's confirmed keywords and stored in that row's own
--     fetch evidence (research_account_fetches.last_success->'relevance'); anything else is NULL. Rows are ordered
--     qualified first, then by relevance, then followers (as before). Read only.
--   * A label only: qualification, the report gate and research_benchmark_rows / research_benchmark_table (what a report
--     freezes) are untouched. Erasure: the value lives in the fetch evidence that erasure already removes.
-- No money. Compatibility: older code ignores the extra field; rows fetched before this carry no relevance (NULL).
-- Repeatable (CREATE OR REPLACE). Recovery: re-run 0282's definition of research_user_benchmarks.
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
    'excluded',b.excluded,'fetchedAt',b.fetched_at,'topicRelevance',b.topic_relevance,
    'refs',jsonb_build_object(
      'followers',CASE WHEN b.followers IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'followers','[]'::jsonb) END,
      'medianViews',CASE WHEN b.median_views IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'medianViews','[]'::jsonb) END,
      'engagementRate',CASE WHEN b.engagement_rate IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'engagementRate','[]'::jsonb) END,
      'postsPerWeek',CASE WHEN b.posts_per_week IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'postsPerWeek','[]'::jsonb) END,
      'lastPublishedAt',CASE WHEN b.last_published_at IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'lastPublishedAt','[]'::jsonb) END))
    ORDER BY b.qualified DESC,b.topic_relevance DESC NULLS LAST,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb) INTO output
  FROM (SELECT b.*,
      -- The relevance benchmark_fetch computed into this row's own fetch evidence (a 0–1 share; anything else is NULL).
      CASE WHEN jsonb_typeof(f.last_success->'relevance'->'value')='number'
        AND (f.last_success->'relevance'->>'value')::numeric BETWEEN 0 AND 1
        THEN (f.last_success->'relevance'->>'value')::numeric END AS topic_relevance
    FROM research_benchmarks b
    JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
    LEFT JOIN research_account_fetches f ON f.id=b.fetch_id AND f.actor_id=a
    WHERE b.actor_id=a AND b.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
    ORDER BY b.qualified DESC,topic_relevance DESC NULLS LAST,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN output;
END $$;
REVOKE ALL ON FUNCTION public.research_user_benchmarks(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.research_user_benchmarks(uuid,uuid) TO service_role;

COMMIT;
