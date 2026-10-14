-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RUNTIME-PROD (0257): a staging test window may admit every signed-in actor (Owner 2026-10-14:
-- "现在的这个测试白名单可以直接放开，不用限制。只要用户没法注册，他也没法使用。").
-- all_actors=true requires an empty actor_ids list; all_actors=false keeps the original 0192 rule.
-- Only the actor-membership test changes in four functions; enablement, expiry, budget, quote, model,
-- network and host-binding checks are untouched. mode<>'staging_test' (production and isolated) returns
-- before any window is read, so those paths are unchanged.
-- Each function is patched at an exact anchor; a missing anchor aborts the migration.
-- No data change: existing windows default to all_actors=false. Rollback: set all_actors=false and refill
-- actor_ids on the window; the column and functions stay compatible with listed windows.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.runtime_test_windows ADD COLUMN IF NOT EXISTS all_actors boolean NOT NULL DEFAULT false;
ALTER TABLE public.runtime_test_windows DROP CONSTRAINT IF EXISTS runtime_test_windows_actor_ids_check;
ALTER TABLE public.runtime_test_windows ADD CONSTRAINT runtime_test_windows_actor_ids_check
 CHECK((all_actors AND cardinality(actor_ids)=0)
  OR (NOT all_actors AND (cardinality(actor_ids) BETWEEN 1 AND 8 OR (NOT enabled AND cardinality(actor_ids)=0))));

DO $all_actors$
DECLARE source text; patch record; hits integer;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
  ('public.runtime_test_window_allowed(uuid,jsonb)',
   'NOT(a=ANY(w.actor_ids))',
   'NOT(w.all_actors OR a=ANY(w.actor_ids))'),
  ('public.runtime_test_policy(uuid,uuid)',
   'NOT(p_actor_id=ANY(w.actor_ids))',
   'NOT(w.all_actors OR p_actor_id=ANY(w.actor_ids))'),
  -- An open window grants maintenance reads only while it is enabled and unexpired.
  ('public.runtime_test_actor_access(uuid)',
   'IF NOT EXISTS(SELECT 1 FROM runtime_test_windows WHERE p_actor_id=ANY(actor_ids))',
   'IF NOT EXISTS(SELECT 1 FROM runtime_test_windows WHERE p_actor_id=ANY(actor_ids)'
    ||' OR (all_actors AND enabled AND clock_timestamp()<expires_at))'),
  -- An open window still admits the actor, so recovery must not treat its execution as finishable.
  ('public.runtime_financial_recovery(uuid,uuid,boolean)',
   'NOT(p_actor_id=ANY(w.actor_ids))',
   'NOT(w.all_actors OR p_actor_id=ANY(w.actor_ids))')
 ) AS t(signature,old_text,new_text) LOOP
  source:=pg_get_functiondef(patch.signature::regprocedure);
  IF position(patch.new_text IN source)>0 THEN CONTINUE; END IF;
  hits:=(length(source)-length(replace(source,patch.old_text,'')))/length(patch.old_text);
  IF hits<>1 THEN RAISE EXCEPTION 'RUNTIME_TEST_ALL_ACTORS_PATCH_MISSING: %',patch.signature; END IF;
  EXECUTE replace(source,patch.old_text,patch.new_text);
 END LOOP;
END $all_actors$;

COMMIT;
