-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: parse each ledger identity once, then read the original runs by their keys.
-- Compatibility: the boolean signature, canonical UUID matching, actor check, deletion marker,
-- callers and privileges are unchanged; both old and new application code use the same helper.
-- Repeatability: CREATE OR REPLACE is idempotent and changes no stored data.
-- Recovery: restore the previous complete definition in tests/content-erasure-perf/rollback.sql;
-- no data restoration is needed because this migration only changes how the predicate reads.
-- No statement_timeout or lock_timeout setting is changed.
BEGIN;
CREATE OR REPLACE FUNCTION public.content_erasure_ledger_owned(j jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH binding AS MATERIALIZED (
  SELECT content_erasure_uuid(j->>'user_id') actor_id,
   array_remove(ARRAY[content_erasure_uuid(j->>'bill2_run_id'),
    content_erasure_uuid(j#>>'{metadata,usage,runId}'),
    content_erasure_uuid(j#>>'{metadata,runId}')],NULL) run_ids,
   array_remove(ARRAY[content_erasure_uuid(j->>'id'),
    content_erasure_uuid(j#>>'{metadata,preDeductId}')],NULL) pre_ids
 )
 SELECT EXISTS(
  -- OFFSET 0 keeps the identity lookup before the actor/deletion filters. Otherwise the planner
  -- can scan all of the actor's deleted runs for every unrelated ledger row again.
  SELECT 1 FROM binding b CROSS JOIN LATERAL (
   SELECT actor_id,content_deleted_at FROM bill2_runs WHERE id=ANY(b.run_ids) OFFSET 0
  ) r
   WHERE r.actor_id=b.actor_id AND r.content_deleted_at IS NOT NULL
  UNION ALL
  SELECT 1 FROM binding b CROSS JOIN LATERAL (
   SELECT actor_id,content_deleted_at FROM bill2_runs WHERE pre_deduct_id=ANY(b.pre_ids) OFFSET 0
  ) r
   WHERE r.actor_id=b.actor_id AND r.content_deleted_at IS NOT NULL
 );
$function$;
COMMIT;
