-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: an account that used research tools could never finish erasure. Its research_plans are scrubbed to the
-- cost key and kept as financial evidence (0263), and erased rows are immutable (erased_row_guard), so their
-- session_id/execution_id keep the erased Runtime session and execution in place. account_erasure_prune_business's
-- delete of that session hits the foreign key (swallowed by design), and account_erasure_business_remaining counted the
-- session forever, so the request stayed 'erasing' with no error code (staging, 10-25).
-- Fix: an erased session shell whose only purpose is the context id of retained, erased research evidence is not
-- remaining work, the same way bill2_runs and legacy artifact evidence keep their original context ids. A session still
-- referenced by an unerased plan keeps counting (its money is not final; financial proof also reports it).
-- Text-marker patch (packages/db/tests/content-erasure/md5-chain.mjs style). Compatibility: count only; no table,
-- data or grant changes, old and new code read the same JSON. Repeatable: marker-skipped. Recovery: CREATE OR REPLACE the
-- function with the 0393 block put back to the single runtime_sessions count line; no data to restore.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE source text; needle text:=E' +(SELECT count(*) FROM runtime_sessions WHERE actor_id=p_profile_id)\n'; BEGIN
 source:=pg_get_functiondef('public.account_erasure_business_remaining(uuid)'::regprocedure);
 IF position('-- 0393 research context' IN source)=0 THEN
  IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
   RAISE EXCEPTION 'ERASURE_RESEARCH_CONTEXT_SOURCE_MISMATCH: account_erasure_business_remaining'; END IF;
  EXECUTE replace(source,needle,E' +(SELECT count(*) FROM runtime_sessions s WHERE s.actor_id=p_profile_id\n'
   || E'  -- 0393 research context: an erased shell kept only as the session id of retained, erased research evidence\n'
   || E'  AND NOT (s.erased_at IS NOT NULL\n'
   || E'   AND EXISTS(SELECT 1 FROM research_plans p WHERE p.session_id=s.id AND p.erased_at IS NOT NULL)\n'
   || E'   AND NOT EXISTS(SELECT 1 FROM research_plans p WHERE p.session_id=s.id AND p.erased_at IS NULL)))\n');
 END IF;
END $$;

REVOKE ALL ON FUNCTION public.account_erasure_business_remaining(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
