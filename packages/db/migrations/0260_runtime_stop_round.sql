-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-NATIVE-OUTPUT follow-up: a stop names the round whose text was on screen. Streamed text carries
-- the BILL2 call sequence of its primary round; runtime_execution 'stop' now accepts that number as an
-- optional `call` next to stopAt/source and keeps it with the immutable stop intent. The host then
-- rebuilds the stopped reply from that call's receipt instead of the last dispatched one, so a stop
-- that arrives after a later round started never saves text the user did not see.
-- Only the input check changes: the first stop intent still wins, settlement is untouched, and a stop
-- without `call` behaves exactly as before. Repeatable: patched only from its known source.
-- No remote database use.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text; patched text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='__TARGET_MD5__' THEN RETURN;END IF;
 IF source_md5<>'6f66e0feeaba637dae8f96acdf2c4e00' THEN RAISE EXCEPTION 'STOP_ROUND_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 IF (length(definition)-length(replace(definition,$a1$   OR (p_result ? 'source' AND p_result->>'source' NOT IN ('assistant','message','final'))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('stopAt','source'))$a1$,'')))
  <>length($a1$   OR (p_result ? 'source' AND p_result->>'source' NOT IN ('assistant','message','final'))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('stopAt','source'))$a1$)
  THEN RAISE EXCEPTION 'STOP_ROUND_ANCHOR_1';END IF;
 definition:=replace(definition,$a1$   OR (p_result ? 'source' AND p_result->>'source' NOT IN ('assistant','message','final'))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('stopAt','source'))$a1$,
  $b1$   OR (p_result ? 'source' AND p_result->>'source' NOT IN ('assistant','message','final'))
   OR (p_result ? 'call' AND (jsonb_typeof(p_result->'call') IS DISTINCT FROM 'number'
    OR coalesce(p_result->>'call','') !~ '^[1-9][0-9]{0,8}$'))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('stopAt','source','call'))$b1$);
 EXECUTE definition;
 patched:=md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure));
 IF patched<>'__TARGET_MD5__' THEN RAISE EXCEPTION 'STOP_ROUND_TARGET_MISMATCH: %',patched;END IF;
END $migration$;
COMMIT;
