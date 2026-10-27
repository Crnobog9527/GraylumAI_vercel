-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- BENCHMARK-COVERAGE / BENCHMARK-SHORTFALL (number 0411 assigned by the controller; Owner 2026-10-27: "用户贴链接核对对标也算
-- 一轮找对标，和关键词搜索一样计入兜底条件"). research_benchmark_rounds counted only completed keyword discoveries, so a
-- session whose accounts all came from links the user pasted had 0 rounds and could never be offered the shortfall card
-- (research_benchmark_shortfall_offer / _choose / _accepted and research_user_shortfall all read this function).
-- Change: a round is also one answer (runtime execution) of the session in which the user's pasted links were verified. That
-- is read from the answer's own supplier operations, which are never rewritten: the answer owns research plans with, for the
-- same platform and the same (already canonical) account the fetch asked the supplier for, a succeeded account_profile and a
-- succeeded account_posts operation whose source is `user_message`, and no failed operation for that account in the plan (a
-- posts page that failed makes the fetch fail). The count does not read research_account_fetches: a later refresh re-claims
-- that row and moves its execution_id and state, which would erase the round; the operations stay as they were. Comparing
-- the two operations with each other (both carry the canonical account) also makes the count independent of how the user
-- wrote the link (@Name, mixed case, full profile URL). A failed, refused or unfinished verification counts nothing. One
-- answer counts once however many links it verified, and an answer that already holds a completed keyword discovery is not
-- counted a second time. Erased or content-deleted answers, plans and operations count nothing, as before. Candidate-card and
-- refresh operations carry another source kind and are not rounds (the discovery that produced the candidates already was one).
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
    JOIN research_plans pp ON pp.execution_id=x.id AND pp.actor_id=a AND pp.session_id=s AND pp.erased_at IS NULL
    JOIN research_operations prof ON prof.plan_id=pp.id AND prof.erased_at IS NULL AND prof.state='succeeded'
      AND prof.result->'args'->'source'->>'kind'='user_message' AND prof.result->'call'->>'dataKind'='account_profile'
    JOIN research_plans pq ON pq.execution_id=x.id AND pq.actor_id=a AND pq.session_id=s AND pq.erased_at IS NULL
    JOIN research_operations posts ON posts.plan_id=pq.id AND posts.erased_at IS NULL AND posts.state='succeeded'
      AND posts.result->'args'->'source'->>'kind'='user_message' AND posts.result->'call'->>'dataKind'='account_posts'
      AND posts.result->'call'->>'platform'=prof.result->'call'->>'platform'
      AND posts.result->'call'->>'query'=prof.result->'call'->>'query'
    WHERE x.actor_id=a AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM research_plans pb
        JOIN research_operations bad ON bad.plan_id=pb.id AND bad.erased_at IS NULL
        WHERE pb.execution_id=x.id AND pb.actor_id=a AND pb.session_id=s AND pb.erased_at IS NULL
          AND bad.state IS DISTINCT FROM 'succeeded'
          AND bad.result->'call'->>'platform'=prof.result->'call'->>'platform'
          AND bad.result->'call'->>'query'=prof.result->'call'->>'query')
      AND NOT EXISTS (SELECT 1 FROM research_discoveries d
        WHERE d.execution_id=x.id AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )::integer
$function$;

COMMIT;
