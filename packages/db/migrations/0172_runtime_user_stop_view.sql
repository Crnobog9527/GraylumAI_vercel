-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C2: v1/v2 history exposes pending user stop independently of bill2_public.
-- This patch depends on the 0171 runtime_view definition.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);
 source_md5:=md5(definition);
 IF source_md5='a25b12ab1ca47f26361bdb0f19cf274f' THEN RETURN;END IF;
 IF source_md5<>'bc60c8e82b1f58419246504dc7fcd0ca' THEN
  RAISE EXCEPTION 'USER_STOP_VIEW_SOURCE_MISMATCH';
 END IF;
 -- Same predicate as 0171 userStop, reusing the view's batched history availability.
 definition:=replace(definition,
  $old$'contentAvailable',availability.available,'billing',bill2_public(b))$old$,
  $new$'contentAvailable',availability.available,'billing',bill2_public(b),
  'userStopPending',coalesce((b.paused_reason='user_stop' AND NOT b.cancel_requested
   AND e.result IS NULL AND availability.available
   AND NOT bill2_erasure_closed(b.actor_id,coalesce(b.pre_deduct_id,b.id))),false))$new$);
 IF md5(definition)<>'a25b12ab1ca47f26361bdb0f19cf274f' THEN
  RAISE EXCEPTION 'USER_STOP_VIEW_TARGET_MISMATCH';
 END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
