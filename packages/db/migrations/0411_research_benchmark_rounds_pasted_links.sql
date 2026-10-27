-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- BENCHMARK-COVERAGE / BENCHMARK-SHORTFALL (number 0411 assigned by the controller; Owner 2026-10-27: "用户贴链接核对对标也算
-- 一轮找对标，和关键词搜索一样计入兜底条件"). research_benchmark_rounds counted only completed keyword discoveries, so a
-- session whose accounts all came from links the user pasted had 0 rounds and could never be offered the shortfall card
-- (research_benchmark_shortfall_offer / _choose / _accepted and research_user_shortfall all read this function).
-- Change: a round is also one answer (runtime execution) of the session in which the user's pasted links were verified, i.e.
-- the answer owns a research plan with a succeeded operation whose source is `user_message`, and an account fetch of that
-- same answer that SUCCEEDED for one of the accounts that operation named. A failed, refused or unfinished verification
-- counts nothing. One answer counts once however many links it verified, and an answer that already holds a completed
-- keyword discovery is not counted a second time. Erased or content-deleted answers, plans and operations count nothing,
-- as before. Candidate-card and refresh fetches carry another source kind and are not rounds (the discovery that produced
-- the candidates already was one).
-- Compatibility: same signature and result type; the result only grows for sessions that have pasted-link verifications, so
-- old and new application code are interchangeable. Existing sessions are re-evaluated by the function itself, no data change.
-- Repeatable: CREATE OR REPLACE only. Recovery: re-apply research_benchmark_rounds from packages/db/functions as of 0410
-- (the discovery-only count); no data or index is touched.
BEGIN;
SET LOCAL lock_timeout='5s';

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
    SELECT count(DISTINCT x.id) FROM runtime_executions x
    JOIN research_plans p ON p.execution_id=x.id AND p.actor_id=a AND p.session_id=s AND p.erased_at IS NULL
    JOIN research_operations o ON o.plan_id=p.id AND o.erased_at IS NULL AND o.state='succeeded'
      AND o.result->'args'->'source'->>'kind'='user_message'
    JOIN research_account_fetches f ON f.execution_id=x.id AND f.actor_id=a AND f.session_id=s AND f.state='succeeded'
      AND o.result->'args'->'accounts' @> jsonb_build_array(jsonb_build_object('account',f.account,'platform',f.platform))
    WHERE x.actor_id=a AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM research_discoveries d
        WHERE d.execution_id=x.id AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )::integer
$function$;

COMMIT;
