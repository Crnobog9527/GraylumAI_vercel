/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- DB-PERF PR-7b-A (number 0365 assigned by the controller). opc_free_conversations (the free
-- conversation list) ran bill2_scope_allowed for every positioning-scope session of the actor before excluding the
-- sessions that belong to a positioning draft or a topic workspace. Those are never listed, so their checks were wasted:
-- on staging's largest list 41 of 68 checked sessions were excluded right after (about 1 800 of 3 100 pages).
-- The two exclusions now run first (OFFSET 0 keeps the planner from merging the inner query back), and the permission
-- check runs on what is left. The same sessions pass the same conditions, so the list, its order and its titles are
-- unchanged; excluded sessions are simply no longer checked (and no longer share-locked by that check).
-- Repeatable: skipped when the marker is present; the patch refuses to run if the text it replaces has changed.
-- Rollback: recreate the function from its definition before this migration (0348's patch); no data changes.
BEGIN;
DO $patch$ DECLARE d text;old_block text;new_block text;
BEGIN
 d:=pg_get_functiondef('public.opc_free_conversations(uuid)'::regprocedure);
 IF position('-- DB-PERF PR-7b-A exclusions first' IN d)=0 THEN
  old_block:=$a$  SELECT session.* FROM runtime_sessions session
  WHERE session.erased_at IS NULL AND session.content_deleted_at IS NULL AND session.actor_id=p_actor_id AND session.scope->>'kind'='positioning_draft'
   AND bill2_scope_allowed(p_actor_id,session.scope)
   AND NOT EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=session.id)
   AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=session.id)
 ) s
$a$;
  new_block:=$a$  -- DB-PERF PR-7b-A exclusions first: the permission check runs only on sessions the list can show.
  SELECT candidate.* FROM (
   SELECT session.* FROM runtime_sessions session
   WHERE session.erased_at IS NULL AND session.content_deleted_at IS NULL AND session.actor_id=p_actor_id AND session.scope->>'kind'='positioning_draft'
    AND NOT EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=session.id)
    AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=session.id)
   OFFSET 0
  ) candidate WHERE bill2_scope_allowed(p_actor_id,candidate.scope)
 ) s
$a$;
  IF array_length(string_to_array(d,old_block),1)<>2 THEN RAISE EXCEPTION 'DB_PERF_FREE_CONVERSATIONS_MISMATCH'; END IF;
  EXECUTE replace(d,old_block,new_block);
 END IF;
END $patch$;
COMMIT;
