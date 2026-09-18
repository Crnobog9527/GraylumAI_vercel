/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Stage A (Owner acceptance remediation): opening identity across revision.
--
-- A stored mentor turn already owns its round (`opc_turns.round_id`). The page
-- needs that ownership exposed so it can tell "the current round already has an
-- opening for this question" apart from "an older round does". Without it a
-- revision created a new round whose questions were suppressed by the previous
-- round's reply, and the round-scoped opening identity could not be checked
-- against server state.
--
-- Additive and backward compatible: same signature, one extra projected key.
-- A database that predates this migration simply returns no `roundId` and the
-- page falls back to its previous behaviour.
BEGIN;
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
 RETURN jsonb_build_object('draftId',d.draft_id,'sessionId',d.session_id,'projectId',d.project_id,'roundId',d.round_id,'mode',d.mode,'snapshot',result,'information',(SELECT jsonb_object_agg(x->>'id',jsonb_build_object('schema',x->'information','values',r.steps->(x->>'id')->'information')) FROM artifact_rounds r,jsonb_array_elements(r.workflow->'steps') x WHERE r.id=d.round_id),
 'turns',(SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'stepId',t.step_id,'questionId',nullif(regexp_replace(coalesce(e.payload->'request'->'selection'->>'task',''),'^opc-(question|opening):',''),''),'roundId',t.round_id,'kind',CASE WHEN t.purpose='plan' THEN 'plan' WHEN e.payload->'request'->'organizeAfter'='true'::jsonb THEN 'organizer' WHEN e.payload->'request'->'selection'->>'task' LIKE 'opc-opening:%' THEN 'opening' ELSE 'mentor' END) ORDER BY e.created_at,e.id),'[]') FROM opc_turns t JOIN runtime_executions e ON e.session_id=t.session_id AND e.request_id=t.request_id AND e.actor_id=p_actor_id WHERE t.draft_id=d.draft_id AND t.session_id=d.session_id),
 'report',artifact_transition(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),'report',d.project_id,d.round_id),
 'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('planId',id,'version',version,'sourceVersionId',source_version_id,'body',CASE WHEN opc_source_allowed(p_actor_id,source_version_id) THEN body ELSE NULL END) ORDER BY version DESC),'[]') FROM opc_plans WHERE draft_id=d.draft_id),
 'handoffs',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'result',h.result)),'[]') FROM opc_handoffs h WHERE draft_id=d.draft_id));
END $$;
REVOKE ALL ON FUNCTION opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;
COMMIT;
