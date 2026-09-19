/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Owner-locked per-question interaction: a question that was already reached and
-- answered must stay reviewable even after an earlier answer is edited back to a
-- provisional value. The current round's answers alone cannot show that, because
-- editing q1 shrinks the current progression prefix; the immutable successful
-- information snapshots of this round can.
--
-- This migration adds one internal, read-only helper plus that helper's bounded
-- output inside the existing `opc_query` read contract. It adds no table, no
-- progress ledger, no request write and no model-call hook, and it does not
-- change progression: server admission and confirmation keep using the current
-- answers and the existing checks.
BEGIN;
-- The scan is scoped to one actor-owned project/round/step; this index keeps it
-- bounded without changing any existing contract.
CREATE INDEX IF NOT EXISTS artifact_requests_opc_information_idx
  ON artifact_requests(project_id, round_id, action);

CREATE OR REPLACE FUNCTION opc_historical_reach(p_actor_id uuid,p_draft_id uuid,p_step_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;step jsonb;ids text[];snap jsonb;prefix int;best int:=-1;i int;status text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 IF step IS NULL THEN RAISE EXCEPTION 'OPC_STEP_DENIED';END IF;
 SELECT array_agg(f->>'id' ORDER BY ord) INTO ids
   FROM jsonb_array_elements(step->'information') WITH ORDINALITY t(f,ord);
 IF ids IS NULL THEN RETURN '[]'::jsonb;END IF;
 -- Only successful information writes of THIS round and step count; a rolled
 -- back transaction never became a stored request.
 FOR snap IN
  SELECT a.payload->'values' v
    FROM artifact_requests a
   WHERE a.project_id=d.project_id AND a.round_id=r.id AND a.action='opc_information'
     AND a.payload->>'stepId'=p_step_id
 LOOP
  prefix:=0;
  FOR i IN 1..coalesce(array_length(ids,1),0) LOOP
   status:=snap->ids[i]->>'status';
   EXIT WHEN status IS NULL OR status NOT IN ('confirmed','deferred');
   prefix:=i;
  END LOOP;
  -- The historical maximum of "leading resolved questions", so a later
  -- provisional edit cannot shrink what was already reached.
  IF prefix>best THEN best:=prefix;END IF;
 END LOOP;
 IF best<0 THEN RETURN '[]'::jsonb;END IF;
 -- Reach = every leading resolved question plus at most its next declared one.
 RETURN to_jsonb(ids[1:least(best+1,coalesce(array_length(ids,1),0))]);
END $$;
REVOKE ALL ON FUNCTION opc_historical_reach(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Re-declare the existing read contract with the bounded reach added per step.
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_draft_id IS NULL THEN
  RETURN jsonb_build_object('drafts',(SELECT coalesce(jsonb_agg(jsonb_build_object('draftId',draft_id,'sessionId',session_id,'projectId',project_id,'roundId',round_id,'mode',mode)),'[]') FROM opc_drafts WHERE actor_id=p_actor_id AND NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)),
   'accounts',(SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',ac.project_id,'platform',platform,'account',account_key,'revision',revision,'sourceVersionId',ac.source_version_id,'profile',CASE WHEN opc_source_allowed(p_actor_id,ac.source_version_id) THEN opc_profile(ac.source_version_id) ELSE NULL END,
    'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',w.work_title,'day',i.day,'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN i.brief ELSE NULL END,'sessionId',ss.id)),'[]') FROM opc_items i JOIN artifact_projects w ON w.id=i.work_item_id JOIN runtime_sessions ss ON ss.actor_id=p_actor_id AND ss.scope=jsonb_build_object('kind','work_item','projectId',ac.project_id,'workItemId',i.work_item_id) WHERE i.account_project_id=ac.project_id))),'[]') FROM opc_accounts ac WHERE actor_id=p_actor_id));
 END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 result:=artifact_query(p_actor_id,'read',d.project_id,d.round_id);
 RETURN jsonb_build_object('draftId',d.draft_id,'sessionId',d.session_id,'projectId',d.project_id,'roundId',d.round_id,'mode',d.mode,'snapshot',result,'information',(SELECT jsonb_object_agg(x->>'id',jsonb_build_object('schema',x->'information','values',r.steps->(x->>'id')->'information','reached',opc_historical_reach(p_actor_id,d.draft_id,x->>'id'))) FROM artifact_rounds r,jsonb_array_elements(r.workflow->'steps') x WHERE r.id=d.round_id),
 'turns',(SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'stepId',t.step_id,'questionId',nullif(regexp_replace(coalesce(e.payload->'request'->'selection'->>'task',''),'^opc-(question|opening):',''),''),'roundId',t.round_id,'kind',CASE WHEN t.purpose='plan' THEN 'plan' WHEN e.payload->'request'->'organizeAfter'='true'::jsonb THEN 'organizer' WHEN e.payload->'request'->'selection'->>'task' LIKE 'opc-opening:%' THEN 'opening' ELSE 'mentor' END) ORDER BY e.created_at,e.id),'[]') FROM opc_turns t JOIN runtime_executions e ON e.session_id=t.session_id AND e.request_id=t.request_id AND e.actor_id=p_actor_id WHERE t.draft_id=d.draft_id AND t.session_id=d.session_id),
 'report',artifact_transition(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),'report',d.project_id,d.round_id),
 'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('planId',id,'version',version,'sourceVersionId',source_version_id,'body',CASE WHEN opc_source_allowed(p_actor_id,source_version_id) THEN body ELSE NULL END) ORDER BY version DESC),'[]') FROM opc_plans WHERE draft_id=d.draft_id),
 'handoffs',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'result',h.result)),'[]') FROM opc_handoffs h WHERE draft_id=d.draft_id));
END $$;
REVOKE ALL ON FUNCTION opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;
COMMIT;
