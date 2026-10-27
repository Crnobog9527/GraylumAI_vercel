-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- BENCHMARK-COVERAGE / BENCHMARK-SHORTFALL (number 0411 assigned by the controller; Owner 2026-10-27: "用户贴链接核对对标也算
-- 一轮找对标，和关键词搜索一样计入兜底条件"). research_benchmark_rounds counted only completed keyword discoveries, so a
-- session whose accounts all came from links the user pasted had 0 rounds and could never be offered the shortfall card
-- (research_benchmark_shortfall_offer / _choose / _accepted and research_user_shortfall all read this function).
-- Change: a round is also one answer (runtime execution) of the session whose verification of pasted links COMPLETED.
-- Earlier drafts of this migration derived that from supplier operations; that was unreliable (platform route sets differ,
-- and a balance pause leaves succeeded operations of a verification that is not finished). The only completion signal is the
-- fetch ending as succeeded in research_account_fetch_finish, so that function now records it, once and for good:
--   research_account_fetches.pasted_executions uuid[] (new, append-only): the answers whose verification of this account
--   completed while a succeeded user_message operation of that answer for the account existed.
-- A refresh, a failed or unknown refresh, or a later "generate" choice re-claims the fetch row (execution_id, state) but never
-- touches this list. research_benchmark_rounds counts each live (not erased, content kept) answer listed in any fetch of the
-- session once, and not again when that answer also holds a completed keyword discovery. Failed, refused, paused or
-- unfinished verifications are never listed. Candidate-card and refresh operations carry another source kind and are not.
-- Backfill (staging only, no real users): fetches already succeeded get their execution_id / last_success_execution_id listed
-- when that answer has a succeeded user_message operation for the account; a refresh that already moved the row hides the
-- original answer, so such an old session can undercount until verified again.
-- Compatibility: one nullable-free column with default '{}' (fast, no rewrite); function signatures and result types are
-- unchanged, so old and new application code are interchangeable. Repeatable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE and
-- a backfill that only adds missing entries. Recovery: re-apply research_benchmark_rounds and research_account_fetch_finish from
-- packages/db/functions as of 0410; the column can stay (unused) or be dropped.
BEGIN;
SET LOCAL lock_timeout='5s';


ALTER TABLE public.research_account_fetches ADD COLUMN IF NOT EXISTS pasted_executions uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.research_account_fetch_finish(a uuid, p_fetch uuid, p_attempt uuid, p_state text, p_evidence jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE f research_account_fetches; metric text;
BEGIN
  -- A success must carry its evidence: a paid result without it could be neither reused nor refreshed.
  IF p_state NOT IN ('succeeded','unknown','failed','failed_charged') OR (p_state='succeeded' AND jsonb_typeof(p_evidence) IS DISTINCT FROM 'object')
  THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  IF p_state='succeeded' THEN
    SELECT * INTO f FROM research_account_fetches WHERE id=p_fetch AND actor_id=a;
    -- The host cache is accountMetrics + classification; query/source/call records remain in research_operations.
    IF p_evidence->>'platform' IS DISTINCT FROM f.platform
     OR research_account_key(f.platform,p_evidence->>'account') IS DISTINCT FROM research_account_key(f.platform,f.account)
     OR jsonb_typeof(p_evidence->'fetchedAt') IS DISTINCT FROM 'string'
     OR NOT pg_input_is_valid(p_evidence->>'fetchedAt','timestamp with time zone')
     OR jsonb_typeof(p_evidence->'metrics') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evidence->'metrics'->'postsAnalyzed') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_evidence->'metrics'->'missing') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_evidence->'metrics'->'wholeHistory') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evidence->'classification'->'qualified') IS DISTINCT FROM 'boolean'
     OR NOT coalesce(p_evidence->'classification' ?& ARRAY['category','excluded'],false)
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    FOREACH metric IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
      IF jsonb_typeof(p_evidence->'metrics'->metric) IS DISTINCT FROM 'object'
       OR NOT (p_evidence->'metrics'->metric ? 'value')
       OR jsonb_typeof(p_evidence->'metrics'->metric->'refs') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    END LOOP;
    IF (p_evidence->'metrics'->>'postsAnalyzed')::numeric NOT BETWEEN 0 AND 30
     OR trunc((p_evidence->'metrics'->>'postsAnalyzed')::numeric)<>(p_evidence->'metrics'->>'postsAnalyzed')::numeric
     OR NOT isfinite((p_evidence->>'fetchedAt')::timestamptz)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'metrics'->'missing') x
       WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt'))
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    FOREACH metric IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'metrics'->metric->'refs') x
         WHERE jsonb_typeof(x)<>'string' OR length(btrim(x#>>'{}'))=0)
       OR ((p_evidence->'metrics'->metric->'value'='null'::jsonb)
         IS DISTINCT FROM (jsonb_array_length(p_evidence->'metrics'->metric->'refs')=0))
      THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
      IF p_evidence->'metrics'->metric->'value'<>'null'::jsonb THEN
        IF metric IN ('lastPublishedAt','earliestPublishedAt') THEN
          IF jsonb_typeof(p_evidence->'metrics'->metric->'value')<>'string'
           OR NOT pg_input_is_valid(p_evidence->'metrics'->metric->>'value','timestamp with time zone')
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
          IF NOT isfinite((p_evidence->'metrics'->metric->>'value')::timestamptz)
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
        ELSE
          IF jsonb_typeof(p_evidence->'metrics'->metric->'value')<>'number'
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
          IF (p_evidence->'metrics'->metric->>'value')::numeric NOT BETWEEN 0 AND 1.7976931348623157e308
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
        END IF;
      END IF;
    END LOOP;
    -- Classification is a tagged union: a known category with no exclusion, or an unqualified exclusion.
    IF NOT coalesce((p_evidence->'classification'->>'category' IN ('head_reference','imitable','fast_rising')
       AND p_evidence->'classification'->'excluded'='null'::jsonb
       AND (p_evidence->'classification'->>'category'<>'head_reference' OR p_evidence->'classification'->'qualified'='false'::jsonb))
      OR (p_evidence->'classification'->'category'='null'::jsonb
       AND p_evidence->'classification'->'qualified'='false'::jsonb
       AND p_evidence->'classification'->>'excluded' IN ('FOLLOWERS_MISSING','FOLLOWERS_BELOW_MIN','NO_PUBLISH_TIME','INACTIVE_30_DAYS','NO_POSTS',
       -- 0268 too few posts
       'TOO_FEW_POSTS')),false)
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  END IF;
  -- A sent attempt ends in any state; an attempt never sent can only end as a (free) failure.
  UPDATE research_account_fetches SET state=p_state,evidence=p_evidence,updated_at=clock_timestamp(),
    last_success=CASE WHEN p_state='succeeded' THEN p_evidence ELSE last_success END,
    last_success_execution_id=CASE WHEN p_state='succeeded' THEN execution_id ELSE last_success_execution_id END
  WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt AND (state='in_progress' OR (state='prepared' AND p_state='failed'));
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM research_account_fetches WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt
    AND state=p_state AND evidence IS NOT DISTINCT FROM p_evidence) THEN RAISE EXCEPTION 'RESEARCH_FETCH_CONFLICT';END IF;
  -- 0411: the whole verification of this account just completed (this is the only place a fetch ends as succeeded). When the
  -- answer that ran it did so for links the user pasted (a succeeded supplier operation of that answer for this account, whose
  -- source is user_message), keep that answer in pasted_executions. The list only ever grows: a later refresh re-claims the
  -- row and moves its execution_id and state, but never takes this record away. research_benchmark_rounds counts it.
  IF p_state='succeeded' THEN
    UPDATE research_account_fetches u SET pasted_executions=array_append(u.pasted_executions,u.execution_id)
    WHERE u.id=p_fetch AND u.actor_id=a AND u.attempt=p_attempt AND u.state='succeeded' AND u.execution_id IS NOT NULL
      AND NOT (u.execution_id=ANY(u.pasted_executions))
      AND EXISTS(SELECT 1 FROM research_plans p JOIN research_operations o ON o.plan_id=p.id
        WHERE p.execution_id=u.execution_id AND p.actor_id=a AND p.session_id=u.session_id AND p.erased_at IS NULL
          AND o.erased_at IS NULL AND o.state='succeeded' AND o.result->'args'->'source'->>'kind'='user_message'
          AND o.result->'call'->>'platform'=u.platform
          AND research_account_key(u.platform,o.result->'call'->>'query')=research_account_key(u.platform,u.account));
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.research_benchmark_rounds(a uuid, s uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (
    SELECT count(*) FROM research_discoveries d
    JOIN runtime_executions x ON x.id=d.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE d.actor_id=a AND d.session_id=s AND d.state='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
  )::integer + (
    SELECT count(*) FROM runtime_executions x
    WHERE x.actor_id=a AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
      AND EXISTS (SELECT 1 FROM research_account_fetches f
        WHERE f.actor_id=a AND f.session_id=s AND x.id=ANY(f.pasted_executions))
      AND NOT EXISTS (SELECT 1 FROM research_discoveries d
        WHERE d.execution_id=x.id AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )::integer
$function$;

UPDATE research_account_fetches f SET pasted_executions=(
  SELECT coalesce(array_agg(DISTINCT p.execution_id),'{}') FROM research_plans p JOIN research_operations o ON o.plan_id=p.id
  WHERE p.actor_id=f.actor_id AND p.session_id=f.session_id AND p.erased_at IS NULL
    AND p.execution_id IN (f.execution_id,f.last_success_execution_id)
    AND o.erased_at IS NULL AND o.state='succeeded' AND o.result->'args'->'source'->>'kind'='user_message'
    AND o.result->'call'->>'platform'=f.platform
    AND research_account_key(f.platform,o.result->'call'->>'query')=research_account_key(f.platform,f.account))
WHERE (f.state='succeeded' OR f.last_success IS NOT NULL) AND f.account IS NOT NULL AND cardinality(f.pasted_executions)=0;

COMMIT;
