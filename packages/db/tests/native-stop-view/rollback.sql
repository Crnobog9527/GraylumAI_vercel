-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Manual recovery only: restore the exact 0171 runtime_view; retain all data.
-- Never apply after a later view change: the source guard must fail on drift.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);
 source_md5:=md5(definition);
 IF source_md5='bc60c8e82b1f58419246504dc7fcd0ca' THEN RETURN;END IF;
 IF source_md5<>'a25b12ab1ca47f26361bdb0f19cf274f' THEN
  RAISE EXCEPTION 'USER_STOP_VIEW_ROLLBACK_SOURCE_MISMATCH';
 END IF;
 -- Reverse only this additive field; restore the old definition byte for byte.
 definition:=replace(definition,
  $old$'contentAvailable',availability.available,'billing',bill2_public(b),
  'userStopPending',coalesce((b.paused_reason='user_stop' AND NOT b.cancel_requested
   AND e.result IS NULL AND availability.available
   AND NOT bill2_erasure_closed(b.actor_id,coalesce(b.pre_deduct_id,b.id))),false))$old$,
  $new$'contentAvailable',availability.available,'billing',bill2_public(b))$new$);
 IF md5(definition)<>'bc60c8e82b1f58419246504dc7fcd0ca' THEN
  RAISE EXCEPTION 'USER_STOP_VIEW_ROLLBACK_TARGET_MISMATCH';
 END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
