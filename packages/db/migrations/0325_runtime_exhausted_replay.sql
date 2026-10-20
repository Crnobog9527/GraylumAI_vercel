-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- AGENT-CORE: an exhausted PAYG resume acquires a fresh owner epoch for replay only.
-- No claim, dispatch, accounting lock or call limit changes. Old hosts already honor live=false.
-- Migration 0325 confirmed by controller; controller applies it after final validation.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_text text; target_text text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);
 IF md5(definition)='b4ea9a842337670209bc852fcf842353' THEN RETURN;END IF;
 IF md5(definition)<>'6e699b3b42b2741ef45a2b8c09cedc5c' THEN RAISE EXCEPTION 'EXHAUSTED_REPLAY_SOURCE_MISMATCH';END IF;
 FOR source_text,target_text IN SELECT * FROM (VALUES
(
$before$   -- Exhausted pre-transport cancellation cannot mint another call. Use the
   -- existing cancellation/financial authority under the original cursor/epoch CAS.
   IF (SELECT count(*) FROM bill2_calls WHERE run_id=b.id)>=b.max_calls THEN
    IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
     THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
    PERFORM runtime_cancel(p_actor_id,e.id);
    RETURN runtime_execution(p_actor_id,e.id,'read',NULL);
   END IF;$before$,
$after$   -- AGENT-CORE exhausted replay: the same CAS/revision checks and locks below
   -- retain the original call ceiling. No missing response may be generated.
   -- Every call must already be settled; unknown costs keep financial recovery.$after$
),
(
$before$   PERFORM runtime_test_window_allowed(p_actor_id,b.payload);
   UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,paused_reason=NULL,$before$,
$after$   IF (SELECT count(*) FROM bill2_calls WHERE run_id=b.id)<b.max_calls THEN
    PERFORM runtime_test_window_allowed(p_actor_id,b.payload);
   END IF;
   UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,paused_reason=NULL,$after$
),
(
$before$   live:=true;
  END IF;
 ELSIF p_action='begin' THEN$before$,
$after$   live:=(SELECT count(*) FROM bill2_calls WHERE run_id=b.id)<b.max_calls;
  END IF;
 ELSIF p_action='begin' THEN$after$
)
 ) AS patches(source_text,target_text) LOOP
  IF (length(definition)-length(replace(definition,source_text,'')))<>length(source_text) THEN
   RAISE EXCEPTION 'EXHAUSTED_REPLAY_ANCHOR_MISMATCH';END IF;
  definition:=replace(definition,source_text,target_text);
 END LOOP;
 EXECUTE definition;
 IF md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure))<>'b4ea9a842337670209bc852fcf842353' THEN
  RAISE EXCEPTION 'EXHAUSTED_REPLAY_TARGET_MISMATCH';END IF;
END $migration$;
COMMIT;
