/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-2c (docs/launch/tasks/FUSION-COMPARE.md §3.4, §4 fusionCompare.list). Placeholder number 9999; the
-- controller assigns the final one at merge.
-- The compare cards of one conversation, so a reloaded page can show them in place and recognise the adopted answer
-- (adoption.executionId is written only by fusion_compare_adopt, so the page cannot forge it). fusion_compares is closed
-- to every API role (0290), hence a SECURITY DEFINER reader with the same ownership and deletion checks as
-- fusion_compare_read. Read only: no table, no existing function and no data change.
-- Also fusion_compare_unjudged: compare calls whose answer was saved but whose verdict was never written (the process ended
-- between the two), for the daily recovery to judge before settlement, as fusion_review_unjudged does for reviews.
-- Rollback: DROP FUNCTION public.fusion_compare_list(uuid,uuid,uuid), public.fusion_compare_unjudged(integer); nothing depends on
-- them except the compare list route (behind the compare switch, off by default) and the recovery step that lists them.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- p_compare_id: one exact compare of the conversation (adoption and its replay), never cut by the newest-50 page.
CREATE OR REPLACE FUNCTION public.fusion_compare_list(p_actor_id uuid, p_session_id uuid, p_compare_id uuid DEFAULT NULL)
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
      AND (p_compare_id IS NULL OR fc.id=p_compare_id)
    ORDER BY fc.created_at DESC LIMIT 50) x;
  RETURN cards;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_list(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_list(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fusion_compare_unjudged(p_limit integer)
RETURNS TABLE(actor_id uuid, compare_id uuid, call_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT fc.actor_id, fc.id, c.id, br.id
  FROM fusion_compares fc JOIN bill2_runs br ON br.fusion_group_id=fc.group_id AND br.actor_id=fc.actor_id
  JOIN bill2_calls c ON c.run_id=br.id
  WHERE fc.group_id IS NOT NULL AND c.fusion_verdict IS NULL AND c.settled_at IS NULL
    AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id)
  ORDER BY c.created_at, c.id LIMIT least(greatest(coalesce(p_limit,50),1),200);
$$;
REVOKE ALL ON FUNCTION public.fusion_compare_unjudged(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_unjudged(integer) TO service_role;

COMMIT;
