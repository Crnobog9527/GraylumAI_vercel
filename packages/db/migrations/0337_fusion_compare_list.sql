/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-2c (docs/launch/tasks/FUSION-COMPARE.md §3.4, §4 fusionCompare.list). Provisional number; the
-- controller assigns the final one at merge.
-- The compare cards of one conversation, so a reloaded page can show them in place and recognise the adopted answer
-- (adoption.executionId is written only by fusion_compare_adopt, so the page cannot forge it). fusion_compares is closed
-- to every API role (0290), hence a SECURITY DEFINER reader with the same ownership and deletion checks as
-- fusion_compare_read. Read only: no table, no existing function and no data change.
-- Rollback: DROP FUNCTION public.fusion_compare_list(uuid,uuid); nothing depends on it except the compare list route,
-- which is behind the compare switch (off by default).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fusion_compare_list(p_actor_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cards jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- A deleted or foreign conversation lists nothing (its compares are cleaned with it, 0290).
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id
    AND content_deleted_at IS NULL AND erased_at IS NULL) THEN RETURN '[]'::jsonb; END IF;
  -- Refused starts never showed a card; the newest 50 are enough for one conversation page.
  SELECT coalesce(jsonb_agg(card ORDER BY created_at),'[]') INTO cards FROM (
    -- workspaceDependencies: adoption must repeat them exactly (fusion_compare_adopt compares the jsonb).
    SELECT fusion_compare_view(fc)||jsonb_build_object('question',fc.question,'workspaceDependencies',fc.workspace_dependencies) card,
      fc.created_at
    FROM fusion_compares fc WHERE fc.actor_id=p_actor_id AND fc.session_id=p_session_id AND fc.group_id IS NOT NULL
    ORDER BY fc.created_at DESC LIMIT 50) x;
  RETURN cards;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_list(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_list(uuid,uuid) TO service_role;

COMMIT;
