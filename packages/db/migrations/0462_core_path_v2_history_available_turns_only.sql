-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch C2 (number 0462): runtime_history_available and runtime_history_availability stop reading the old
-- execution tables (runtime_executions, runtime_history_dependencies, bill2_runs) and the old billing checks.
-- Owner/controller decision (2026-11-02): history of an old-path execution has no provenance. The production database is built new
-- without old data and staging holds test data only, so this is not a new product decision. An execution id therefore counts as
-- unavailable for every caller (opc_content_allowed, opc_result_link_available, content_erasure_saved_readable, fusion_compare_context ...);
-- content made on the turn path carries a turn id and is judged by its own functions (opc_content_turn_available), unchanged here.
-- Compatible: same signatures and result shapes; callers need no change. Repeatable: CREATE OR REPLACE.
-- Recovery: re-apply the previous definitions (packages/db/functions/runtime/runtime_history_available.sql and
-- runtime_history_availability.sql at the parent commit); the *_before_memo functions are left in place; no data is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_history_available(p_execution_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_history_availability(p_execution_ids uuid[])
 RETURNS TABLE(execution_id uuid, available boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 RETURN QUERY SELECT requested.id,false FROM (SELECT DISTINCT unnest(p_execution_ids) id) requested;
END $function$;

COMMIT;
