-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS / BILL-PAYG: a research subcall the balance cannot start pauses the turn between two steps and
-- continues after a top-up (MASTER_PLAN §2.1, 2026-10-01). A benchmark_fetch account takes several paid subcalls
-- under one attempt; when the pause falls between them, the attempt is already marked sent (in_progress).
--   * research_account_fetch_claim: the same answer that holds an in-progress attempt (same execution and the same
--     refresh grant, or none) gets that attempt back with resumed=true. The host reuses the subcalls it already
--     finished (stable operation ids) and sends only the rest, so nothing is paid twice. Any other answer still sees
--     the attempt as in progress and never takes it over; finished attempts are unchanged.
-- Compatibility: additive output field; old code ignores it and keeps treating the attempt as in progress.
-- Repeatable: marker-skipped anchored patch. Recovery: replace the marked block with nothing (the 0263 text).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.research_account_fetch_claim(uuid,uuid,uuid,text,text,uuid)'::regprocedure);
 IF position('-- 0283 balance pause resume' IN definition)=0 THEN
  needle:=$n$  IF p_refresh IS NOT NULL THEN
    IF f.state='failed_charged' THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;$n$;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'RESEARCH_FETCH_CLAIM_SOURCE_MISMATCH: 0283'; END IF;
  EXECUTE replace(definition,needle,$r$  -- 0283 balance pause resume: only the answer that marked this attempt sent continues it.
  IF f.state='in_progress' AND f.execution_id=e AND f.refresh_id IS NOT DISTINCT FROM p_refresh THEN
    RETURN jsonb_build_object('claimed',true,'fetchId',f.id,'attempt',f.attempt,'resumed',true);
  END IF;
$r$||needle);
 END IF;
END $$;

COMMIT;
