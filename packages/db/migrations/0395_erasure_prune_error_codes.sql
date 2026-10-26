-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: account_erasure_prune_business swallowed foreign_key_violation/check_violation with NULL, so a request
-- that could never reach 0 stayed 'erasing' with empty executor_error_codes (staging 10-25, 12 hours to diagnose).
-- Fix: the delete is still skipped and the pass still continues (no cascade, no bypass, nothing more or less deleted),
-- but each failed table leaves a fixed code ERASURE_PRUNE_<SQLSTATE>_<TABLE> (at most 5) on the executor round when
-- business work still remains. A designed retention that no longer counts as remaining stays silent, so a completed
-- request carries no stale code. lock_not_available stays silent: another writer holds the row and the next round
-- retries it. account_erasure_executor_finish keeps these database-side codes when it writes the processor's codes.
-- The 0355 session-table pass keeps its own handler verbatim: runtime_session_batches/history are leaves (no table
-- references them), so only a lock wait can reach it, and 0355 re-runs by matching that exact block text.
-- review_codes, local_cleaned_at, stage and every remaining count are unchanged, so completion is judged as before.
-- Text-marker patch (0393 style). Compatibility: no table, column, data or grant change; old and new TypeScript read the
-- same results (codes are only an array column the executor already writes). Repeatable: marker-skipped. Recovery:
-- CREATE OR REPLACE both functions from packages/db/functions/erasure as of 0394; no data to restore (codes are
-- rewritten by every executor claim).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE source text; patched text; part text[];
BEGIN
 source:=pg_get_functiondef('public.account_erasure_prune_business(uuid,integer)'::regprocedure);
 IF position('-- 0395 prune diagnostics' IN source)=0 THEN
  patched:=source;
  FOREACH part SLICE 1 IN ARRAY ARRAY[
   ARRAY[E'removed integer:=0; legacy_evidence boolean;\n',
    E'removed integer:=0; legacy_evidence boolean; failed text[]:=''{}''; code text;\n'],
   ARRAY[E'   EXCEPTION WHEN foreign_key_violation OR check_violation OR lock_not_available THEN\n'
    || E'    -- A retained financial parent or a shared dependency stays. No cascade/trigger bypass.\n    NULL;\n',
    E'   -- A retained financial parent or a shared dependency stays. No cascade/trigger bypass.\n'
    || E'   EXCEPTION WHEN foreign_key_violation OR check_violation THEN\n'
    || E'    -- 0395 prune diagnostics\n'
    || E'    code:=''ERASURE_PRUNE_''||SQLSTATE||''_''||upper(t);\n'
    || E'    IF cardinality(failed)<5 AND code<>ALL(failed) THEN failed:=failed||code; END IF;\n'
    || E'   WHEN lock_not_available THEN\n'
    || E'    NULL; -- another writer holds the row; the next round retries it\n'],
   ARRAY[E' RETURN removed;\n',
    E' -- 0395: a failed delete while business work remains is why the request cannot finish; report it on this\n'
    || E' -- executor round (executor_finish keeps it). Review codes and completion are unchanged.\n'
    || E' IF cardinality(failed)>0 AND account_erasure_business_remaining(p_profile_id)>0 THEN\n'
    || E'  UPDATE account_erasure_requests SET executor_error_codes=executor_error_codes||ARRAY(SELECT c FROM unnest(failed) c\n'
    || E'   WHERE c<>ALL(executor_error_codes)) WHERE profile_id=p_profile_id;\n'
    || E' END IF;\n RETURN removed;\n']
  ] LOOP
   IF length(patched)-length(replace(patched,part[1],''))<>length(part[1]) THEN
    RAISE EXCEPTION 'ERASURE_PRUNE_CODES_SOURCE_MISMATCH: account_erasure_prune_business'; END IF;
   patched:=replace(patched,part[1],part[2]);
  END LOOP;
  EXECUTE patched;
 END IF;

 source:=pg_get_functiondef('public.account_erasure_executor_finish(uuid,uuid,uuid,text[],boolean,boolean)'::regprocedure);
 IF position('-- 0395 prune diagnostics' IN source)=0 THEN
  part:=ARRAY[E' UPDATE account_erasure_requests SET executor_error_codes=p_codes,\n',
   E' UPDATE account_erasure_requests SET executor_error_codes=p_codes||ARRAY(SELECT c FROM unnest(executor_error_codes) c\n'
   || E'  -- 0395 prune diagnostics: this round''s database-side codes survive the processor''s list\n'
   || E'  WHERE left(c,14)=''ERASURE_PRUNE_'' AND c<>ALL(p_codes)),\n'];
  IF length(source)-length(replace(source,part[1],''))<>length(part[1]) THEN
   RAISE EXCEPTION 'ERASURE_PRUNE_CODES_SOURCE_MISMATCH: account_erasure_executor_finish'; END IF;
  EXECUTE replace(source,part[1],part[2]);
 END IF;
END $$;

COMMIT;
