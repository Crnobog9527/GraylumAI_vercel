-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 round 13 (Owner 2026-11-03, "同意供应商故障那次不算一轮"): a benchmark keyword discovery that the data supplier could not
-- serve at all (HTTP 402, 401, 403, 429 or 5xx answered, and not one account or post came out of it) is no longer a search round.
-- The discovery stays saved as completed; the API marks it with cursor.supplierDown = true and research_benchmark_rounds skips it.
-- A discovery that got part of its data, or whose supplier answered normally with nothing found, still counts (0320); so does a pasted-link
-- check that fetched the profile, also on a turn whose discovery did not count. Every consumer reads the rounds through this function
-- (research_benchmark_shortfall_offer / _choose / _accepted, research_user_shortfall, research_turn_apply), so none is rewritten.
-- Compatible: one function body, same signature and result type; old discoveries have no mark and count as before. Repeatable:
-- CREATE OR REPLACE. Recovery: restore the 0320 body (the mark is ignored by it).
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
    WHERE d.actor_id=a AND d.session_id=s AND d.state='completed' AND d.turn_id IS NOT NULL
      AND coalesce(d.cursor->>'supplierDown','')<>'true'
  )::integer + (
    -- A turn's pasted-link check, unless that turn also completed a counted discovery (one turn, one round, as above).
    SELECT count(DISTINCT p)::integer FROM research_account_fetches f CROSS JOIN LATERAL unnest(f.pasted_turns) p
    WHERE f.actor_id=a AND f.session_id=s AND NOT EXISTS (SELECT 1 FROM research_discoveries d
      WHERE d.turn_id=p AND d.actor_id=a AND d.session_id=s AND d.state='completed'
        AND coalesce(d.cursor->>'supplierDown','')<>'true')
  )
$function$;

COMMIT;
