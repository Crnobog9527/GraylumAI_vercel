-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 fix: 定稿 (finalize) of a report that used benchmark numbers failed with REPORT_DATA_INVALID (HTTP 409).
-- report_final_data looked up the conversation of the report in runtime_executions to recompute the benchmark table hash;
-- a report of the turn path has no such row, so the actor and conversation were null, the recomputed hash was the hash of
-- an empty table and never matched the frozen one. The conversation now comes from the document source (report_turn_source),
-- which is what report_document_data_source already uses to hash the table the numbers were checked against.
-- Compatible: same signature and result; only reports with benchmark numbers (data.benchmarkHash) reach the changed lines.
-- Repeatable: whole-function CREATE OR REPLACE; grants are kept. Recovery: re-apply the 0300 text from git history; nothing is
-- written or removed, so nothing needs restoring.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.report_final_data(source jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE raw text:=current_setting('graylum.report_data',true);d jsonb;a uuid;sid uuid;
BEGIN
 IF raw IS NULL OR raw='' THEN RETURN '{}'::jsonb; END IF;
 d:=raw::jsonb;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'bodyHash' IS DISTINCT FROM source->>'bodyHash'
  OR d->'dataVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'data') IS DISTINCT FROM 'object'
  OR jsonb_typeof(d->'dropped') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'textEdited') IS DISTINCT FROM 'array'
  OR jsonb_typeof(d->'validatedAt') IS DISTINCT FROM 'string' OR octet_length(d::text)>65536
  OR report_body_parts(source->>'body')->>'block' IS NULL THEN
  RAISE EXCEPTION 'REPORT_DATA_INVALID'; END IF;
 -- Benchmark numbers were taken from the table with this hash: it must still be the table now. Same locks and order as
 -- 0268's research_benchmark_report_current, so a refresh either commits first (and this refuses) or waits.
 IF d ? 'benchmarkHash' THEN
  -- The report turn's conversation (the document source has proved it is the actor's).
  SELECT s.actor_id,s.id INTO a,sid FROM runtime_sessions s WHERE s.id=(source->>'sessionId')::uuid;
  PERFORM 1 FROM research_account_fetches WHERE session_id=sid FOR SHARE;
  PERFORM 1 FROM research_benchmarks WHERE session_id=sid FOR SHARE;
  IF a IS NULL OR (research_benchmark_table(a,sid)->>'hash') IS DISTINCT FROM d->>'benchmarkHash' THEN RAISE EXCEPTION 'REPORT_DATA_INVALID'; END IF;
 END IF;
 RETURN jsonb_build_object('data',d-'bodyHash'-'benchmarkHash');
END $function$;

COMMIT;
