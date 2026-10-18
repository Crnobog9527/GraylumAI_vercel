/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-2b (docs/launch/tasks/FUSION-COMPARE.md §3.1, §3.2). Number allocated by the controller.
-- Additions on top of 0290; one nullable column, no data migration:
--  * fusion_compare_context: the conversation as the next ordinary turn would see it, read in ONE transaction under the
--    session lock together with the history revision and the current work material, so the revision a compare freezes is
--    exactly the revision of the history it was built from (a turn appended in between makes the begin refuse as stale);
--  * fusion_compare_view returns snapshotHash (written at begin since 0290): a start resumed after the paid judgement
--    but before the group exists must rebuild exactly that snapshot;
--  * the positioning outcome's fallback flag is stored with the verdict (fusion_compares.gate_fallback, fusion_compare_gate gets a
--    fourth argument): a start resumed after the paid judgement replays the stored rule instead of rebuilding it from today's
--    refund count, which may have changed in between;
--  * fusion_compare_end: ends a compare that has no group yet (refused, nothing charged) when that resume finds the
--    snapshot changed. A compare with a group is stopped (fusion_compare_stop), never ended here.
-- Rollback (nothing depends on these in stored data, and no route calls them while the compare switch is off):
-- DROP FUNCTION public.fusion_compare_context(uuid,uuid,integer); DROP FUNCTION public.fusion_compare_end(uuid,uuid);
-- DROP FUNCTION public.fusion_compare_gate(uuid,uuid,text,boolean); then re-run the fusion_compare_gate and
-- fusion_compare_view definitions of 0290_fusion_compare.sql (three-argument gate, view without 'snapshotHash' and
-- 'gateFallback'); ALTER TABLE public.fusion_compares DROP COLUMN gate_fallback. The TypeScript treats a missing
-- snapshotHash as "no check" and a missing gateFallback as "derive it from the gate state".
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.fusion_compares ADD COLUMN IF NOT EXISTS gate_fallback boolean;

CREATE OR REPLACE FUNCTION public.fusion_compare_view(fc fusion_compares) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('compareId',fc.id,'requestId',fc.request_id,'sessionId',fc.session_id,'groupId',fc.group_id,
    'historyRevision',fc.history_revision,'state',CASE WHEN fc.state='admitting' AND fc.created_at<=clock_timestamp()-interval '5 minutes'
      THEN 'refused' ELSE fc.state END,'gateVerdict',fc.gate_verdict,'config',fc.config,'adoption',fc.adoption,'createdAt',fc.created_at,
    'snapshotHash',fc.snapshot_hash,'gateFallback',fc.gate_fallback);
$$;
REVOKE ALL ON FUNCTION public.fusion_compare_view(fusion_compares) FROM PUBLIC,anon,authenticated,service_role;

-- The positioning outcome (verdict and whether the turn carries the fallback rule), written once by the request that created
-- the record. Repeating the same outcome answers the same view; a different one is a conflict. block ends the compare.
DROP FUNCTION IF EXISTS public.fusion_compare_gate(uuid,uuid,text);
CREATE OR REPLACE FUNCTION public.fusion_compare_gate(p_actor_id uuid, p_compare_id uuid, p_verdict text, p_fallback boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_verdict IS NULL OR p_verdict NOT IN ('clear','allow','block','unavailable') OR p_fallback IS NULL
    OR (p_verdict='block' AND p_fallback) THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.gate_verdict IS NOT NULL THEN
    IF fc.gate_verdict<>p_verdict OR fc.gate_fallback IS DISTINCT FROM p_fallback THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
    RETURN fusion_compare_view(fc);
  END IF;
  IF fc.state<>'admitting' OR fc.created_at<=clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
  UPDATE fusion_compares SET gate_verdict=p_verdict,gate_fallback=p_fallback,
    state=CASE WHEN p_verdict='block' THEN 'refused' ELSE state END,updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  RETURN fusion_compare_view(fc);
END $$;

-- The last p_limit usable history items (oldest first) as {revision, item}, the session revision they belong to, whether a
-- turn is running (the same replaceable-pointer rule as runtime_admit and fusion_compare_adopt), and the current work
-- material exactly as runtime_session_context reports it. Items an ordinary turn would not be allowed to read (the
-- execution behind them is unavailable) are left out, as in runtime admission.
CREATE OR REPLACE FUNCTION public.fusion_compare_context(p_actor_id uuid, p_session_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions; ctx jsonb; items jsonb; busy boolean;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR SHARE;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_SESSION_GONE'; END IF;
  ctx:=runtime_session_context(p_actor_id,s.id);
  WITH bounded AS MATERIALIZED (
    SELECT h.revision,h.execution_id,h.item FROM runtime_session_history h
    WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
    ORDER BY h.revision DESC LIMIT p_limit+128
  ), availability AS MATERIALIZED (
    SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM bounded))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('revision',x.revision,'item',x.item) ORDER BY x.revision),'[]') INTO items
  FROM (SELECT b.revision,b.item FROM bounded b JOIN availability a ON a.execution_id=b.execution_id
    WHERE a.available ORDER BY b.revision DESC LIMIT p_limit) x;
  busy:=s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution
    JOIN bill2_runs old_run ON old_run.id=old_execution.billing_run_id
    WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
      AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
      AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
      AND old_run.closed AND old_run.cancel_requested);
  RETURN jsonb_build_object('revision',s.revision,'busy',busy,'items',items,
    'scopeMaterial',ctx->'scopeMaterial','materialRevision',ctx->'materialRevision');
END $$;

-- Ends a compare that has no group yet: refused, nothing was held, nothing is charged. Idempotent for a compare that is
-- already over. A compare with a group is never ended here (its runs hold money; fusion_compare_stop settles them).
CREATE OR REPLACE FUNCTION public.fusion_compare_end(p_actor_id uuid, p_compare_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL OR fc.group_id IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.state='admitting' THEN
    UPDATE fusion_compares SET state='refused',updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  END IF;
  RETURN fusion_compare_view(fc);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_compare_context(uuid,uuid,integer)','fusion_compare_end(uuid,uuid)',
    'fusion_compare_gate(uuid,uuid,text,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
COMMIT;
