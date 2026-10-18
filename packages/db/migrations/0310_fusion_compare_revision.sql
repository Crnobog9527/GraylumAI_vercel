/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
-- Post-merge review #1099 / discussion_r4305990063.
-- Reject a compare snapshot whose conversation advanced during the positioning check, before any
-- billing group or run is created. New admissions lock session -> compare, as adoption and erasure do.
-- Existing groups keep frozen replay semantics even when the conversation subsequently advances.
-- Rollback: restore fusion_group_admit from 0290_fusion_compare.sql; no data or schema changes.
-- Pending controller-assigned migration number; this tests/ file is NOT a migration and is not applied by deployment.
-- After allocation, move unchanged SQL into migrations/ and reapply after 0290 in payg/thresholds-migration.mjs.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $compare_revision_repair$
DECLARE source text; old_text text; new_text text;
BEGIN
  source := pg_get_functiondef('public.fusion_group_admit(uuid,uuid,text,uuid,jsonb)'::regprocedure);
  IF position('-- compare-revision-recheck' IN source) > 0 THEN RETURN; END IF;
  old_text := 'gid uuid; fc fusion_compares; lim jsonb;';
  new_text := 'gid uuid; fc fusion_compares; s runtime_sessions; lim jsonb;';
  IF array_length(string_to_array(source, old_text), 1) <> 2 THEN
    RAISE EXCEPTION 'FUSION_COMPARE_REVISION_SOURCE_MISMATCH: declaration';
  END IF;
  source := replace(source, old_text, new_text);
  old_text := $old$    SELECT * INTO fc FROM fusion_compares WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
    IF fc.id IS NULL OR fc.session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;$old$;
  new_text := $new$    -- compare-revision-recheck: session before compare, matching adoption and conversation deletion.
    SELECT * INTO s FROM runtime_sessions WHERE id=p_source_session_id AND actor_id=p_actor_id FOR SHARE;
    IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
    SELECT * INTO fc FROM fusion_compares WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
    IF fc.id IS NULL OR fc.session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
    IF s.revision<>fc.history_revision THEN RAISE EXCEPTION 'FUSION_COMPARE_STALE'; END IF;$new$;
  IF array_length(string_to_array(source, old_text), 1) <> 2 THEN
    RAISE EXCEPTION 'FUSION_COMPARE_REVISION_SOURCE_MISMATCH: admission';
  END IF;
  EXECUTE replace(source, old_text, new_text);
END $compare_revision_repair$;

COMMIT;
