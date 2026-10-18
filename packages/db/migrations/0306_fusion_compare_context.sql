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
-- 'gateFallback'), and the fusion_compare_adopt definition of 0290 (without the work-material condition); ALTER TABLE public.fusion_compares DROP COLUMN gate_fallback. The TypeScript treats a missing
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

-- fusion_compare_adopt: 0290's definition plus one more stale condition, the work-material revision recorded with the
-- request (config.materialRevision) against the session's current one.
CREATE OR REPLACE FUNCTION public.fusion_compare_adopt(p_actor_id uuid, p_compare_id uuid, p_column integer,
  p_request_id uuid, p_billing jsonb, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares; s runtime_sessions; r bill2_runs; o fusion_call_outputs; b jsonb; e runtime_executions;
  answer text; user_text text;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- Lock order as runtime admission and conversation deletion: session, then the compare record.
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_compares f2 ON f2.session_id=s2.id
    WHERE f2.id=p_compare_id AND f2.actor_id=p_actor_id AND s2.actor_id=p_actor_id FOR UPDATE OF s2;
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_SESSION_GONE'; END IF;
  IF fc.adoption IS NOT NULL THEN
    IF fc.adoption->>'requestId'=p_request_id::text THEN
      IF fc.adoption->>'column' IS DISTINCT FROM p_column::text THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
      RETURN jsonb_build_object('state','adopted','adoption',fc.adoption);
    END IF;
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTED';
  END IF;
  IF fc.group_id IS NULL OR fc.state NOT IN ('running','finished','stopped') THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  SELECT * INTO r FROM bill2_runs WHERE fusion_group_id=fc.group_id AND actor_id=p_actor_id
    AND payload#>>'{input,fusion,index}'=p_column::text;
  SELECT o2.* INTO o FROM fusion_call_outputs o2 JOIN bill2_calls c ON c.id=o2.call_id
    WHERE o2.run_id=r.id AND c.fusion_verdict='usable' AND c.settled_at IS NOT NULL;
  IF r.id IS NULL OR NOT r.closed OR o.call_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_NOT_ADOPTABLE'; END IF;
  -- The main conversation moved on (or a turn is running): hand back a quote, change nothing.
  -- "A turn is running" uses runtime_admit's rule: a stopped turn whose cancelled run only waits for its cost
  -- (cost_pending, closed, cancel requested) is replaceable and does not block.
  -- The work material (brief) is fenced like the history: a change after the compare started makes the answer stale.
  IF s.revision<>fc.history_revision
    OR fc.config->>'materialRevision' IS DISTINCT FROM runtime_session_context(p_actor_id,s.id)->>'materialRevision' OR (s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution
      JOIN bill2_runs old_run ON old_run.id=old_execution.billing_run_id
      WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
        AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
        AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
        AND old_run.closed AND old_run.cancel_requested)) THEN
    RETURN jsonb_build_object('state','stale','quote',o.body);
  END IF;
  -- Two history items: the compare question as the user turn, the chosen answer as the assistant turn.
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)<>2 THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  user_text:=coalesce(p_items#>>'{0,content}',p_items#>>'{0,content,0,text}');
  answer:=coalesce(p_items#>>'{1,content,0,text}',p_items#>>'{1,content}');
  IF p_items#>>'{0,role}' IS DISTINCT FROM 'user' OR p_items#>>'{1,role}' IS DISTINCT FROM 'assistant'
    OR user_text IS DISTINCT FROM fc.question OR answer IS DISTINCT FROM o.body THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  -- The adoption run: the host freezes it like an ordinary turn of this conversation; zero calls, zero charge.
  IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL OR p_billing ? 'fusionGroupId'
    OR p_billing#>'{input,fusionAdoption}' IS DISTINCT FROM jsonb_build_object('compareId',fc.id,'column',p_column)
    OR p_billing#>>'{input,input}' IS DISTINCT FROM fc.question
    OR p_billing#>'{input,dependencies}' IS DISTINCT FROM fc.workspace_dependencies THEN
    RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  -- The adoption carries the Skill identity the compare was frozen with (none when none was used).
  IF p_billing->>'moduleId' IS DISTINCT FROM fc.config#>>'{skill,moduleId}'
    OR p_billing->>'revisionId' IS DISTINCT FROM fc.config#>>'{skill,revisionId}'
    OR (fc.config#>>'{skill,skillId}' IS NOT NULL AND p_billing->>'skillId' IS DISTINCT FROM fc.config#>>'{skill,skillId}')
    OR (fc.config#>>'{skill,moduleId}' IS NULL AND p_billing ?| ARRAY['moduleId','skillId','revisionId'])
  THEN RAISE EXCEPTION 'FUSION_COMPARE_SKILL_MISMATCH'; END IF;
  IF p_billing->>'revisionId' IS NOT NULL THEN
    PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
      AND skill_id=(p_billing->>'skillId')::uuid AND active AND model_id=(p_billing->>'modelId')::uuid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED'; END IF;
  END IF;
  PERFORM runtime_context_allowed(p_actor_id,p_billing->'input');
  b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
  INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
    VALUES(p_actor_id,s.id,p_request_id,p_billing->'input',(b->>'id')::uuid,s.revision) RETURNING * INTO e;
  UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
  PERFORM bill2_cancel(p_actor_id,e.billing_run_id);
  PERFORM bill2_finalize(p_actor_id,e.billing_run_id);
  IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (NOT closed OR coalesce(charged,0)<>0)) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTION_BILLING'; END IF;
  UPDATE runtime_executions SET state='cancelled',result=jsonb_build_object('body',o.body,'completeness','complete')
    WHERE id=e.id RETURNING * INTO e;
  INSERT INTO runtime_session_batches VALUES(s.id,e.id,0,p_items,s.revision,s.revision+2);
  INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
    SELECT s.id,s.revision+ordinality,e.id,value FROM jsonb_array_elements(p_items) WITH ORDINALITY;
  UPDATE runtime_sessions SET revision=revision+2 WHERE id=s.id;
  UPDATE fusion_compares SET adoption=jsonb_build_object('requestId',p_request_id,'column',p_column,'runId',r.id,
      'adoptionRunId',e.billing_run_id,'executionId',e.id,'fromRevision',s.revision,'toRevision',s.revision+2),
    updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  RETURN jsonb_build_object('state','adopted','adoption',fc.adoption);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_compare_context(uuid,uuid,integer)','fusion_compare_end(uuid,uuid)',
    'fusion_compare_gate(uuid,uuid,text,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
COMMIT;
