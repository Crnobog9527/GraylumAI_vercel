-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RUNTIME-PROD review panel (docs/launch/tasks/RUNTIME-PROD.md section 7): a production Fusion run has no test window,
-- so the recovery inventory returns its own frozen policy (id = rules.quoteVersion, mode = production) for receipt
-- lookups and settlement, exactly as it returns the window's for a staging run. Admission, the group claim and every
-- dispatch already go through runtime_test_window_allowed, which sends production runs to runtime_production_allowed
-- (0292/0293); nothing else changes.
-- Patched at an exact anchor (a missing anchor aborts the migration, a rerun is a no-op). No data change.
-- Rollback: none needed; without it production Fusion receipts are looked up by no one (staging is unaffected).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $runtime_production_fusion$
DECLARE source text; patch record; hits integer;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
  ('public.fusion_pending_financial_batch(integer,timestamp with time zone,uuid)',
   $o$    CASE WHEN r.payload->>'mode'='staging_test' AND r.test_window_id IS NOT NULL THEN jsonb_build_object($o$,
   $n$    CASE WHEN r.payload->>'mode'='production' AND r.test_window_id IS NULL THEN jsonb_build_object('mode','production',
      'id',r.payload->'rules'->>'quoteVersion','callPolicies',r.payload->'callPolicy','creditsPerUsd',r.payload->'rules'->>'creditsPerUsd',
      'multiplier',r.payload->'rules'->>'multiplier','expiresAt',r.deadline)
    WHEN r.payload->>'mode'='staging_test' AND r.test_window_id IS NOT NULL THEN jsonb_build_object($n$)
 ) AS t(signature,old_text,new_text) LOOP
  source:=pg_get_functiondef(patch.signature::regprocedure);
  IF position(patch.new_text IN source)>0 THEN CONTINUE; END IF;
  hits:=(length(source)-length(replace(source,patch.old_text,'')))/length(patch.old_text);
  IF hits<>1 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_FUSION_PATCH_MISSING: %',patch.signature; END IF;
  EXECUTE replace(source,patch.old_text,patch.new_text);
 END LOOP;
END $runtime_production_fusion$;

COMMIT;
