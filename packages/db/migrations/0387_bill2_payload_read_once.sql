-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-100 C2 (Owner 2026-10-25 approved the DB-100 plan): claim and dispatch read the run payload once.
--
-- A bill2_runs.payload carries the frozen runtime context (about 20 KB compressed, 33 KB as text) and is
-- stored out of line (TOAST). In a PL/pgSQL function, SELECT * INTO r keeps only a pointer to that value,
-- so every r.payload access, and every helper that receives r.payload, fetches the value from the TOAST
-- table again and decompresses it again. bill2_payg_claim and bill2_dispatch pass r.payload to
-- runtime_billing_allowed and runtime_test_window_allowed and read it themselves (report generation,
-- quote checks), several times per call.
--
-- Now each of the two functions fetches and decompresses the payload once, right after it locks the run,
-- and keeps the plain value in r. The value is the same jsonb (concatenating an empty object returns the
-- object unchanged), the run row is not written, and every check reads the same fields as before.
-- bill2_record and bill2_payg_finalize do not read the payload; they are unchanged.
-- In-place patches of the current definitions; each anchor must match exactly once. Re-running is a no-op.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE src text;anchor text;fn regprocedure;
BEGIN
 FOREACH fn IN ARRAY ARRAY['public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure,
  'public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure] LOOP
  src:=pg_get_functiondef(fn);
  CONTINUE WHEN position('-- DB-100 C2 payload read once' IN src)>0;
  anchor:=CASE fn WHEN 'public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure
   THEN 'SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;'
   ELSE 'SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;' END;
  IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'DB100_C2_ANCHOR_MISSING: %',fn;END IF;
  src:=replace(src,anchor,anchor
   ||E'\n -- DB-100 C2 payload read once: fetch and decompress the TOAST value here, not at every r.payload use.'
   ||E'\n -- A run payload is always a JSON object (bill2_prepare); || ''{}'' returns it unchanged.'
   ||E'\n r.payload:=r.payload||''{}''::jsonb;');
  EXECUTE src;
 END LOOP;
END $$;

COMMIT;
