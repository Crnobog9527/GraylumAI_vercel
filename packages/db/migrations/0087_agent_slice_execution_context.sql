/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- Private assembly input. No credentials, method files or SDK state are returned.
CREATE OR REPLACE FUNCTION public.agent_slice_context(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE;p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;account_name text;body text;
BEGIN
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id;
 SELECT * INTO p FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id;
 IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
  OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=e.conversation_id AND user_id=p_actor_id AND is_deleted='false')
 THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,e.revision_id,NULL,NULL);
 SELECT * INTO r FROM artifact_rounds WHERE id=e.round_id AND project_id=p.id;
 SELECT account INTO account_name FROM artifact_projects WHERE id=p.source_project_id;
 IF r.state<>'draft' OR r.revision_id<>e.revision_id OR artifact_generation_basis(r.workflow,r.steps,e.step_id) IS DISTINCT FROM e.basis
  OR NOT artifact_evidence_allowed(p.id,e.evidence_ids) OR NOT agent_slice_preferences_valid(p_actor_id,e.preference_refs,account_name)
 THEN RAISE EXCEPTION 'slice context changed'; END IF;
 SELECT payload->>'body' INTO body FROM artifact_requests WHERE project_id=p.id AND request_id=e.request_id AND action='slice_input';
 IF body IS NULL THEN RAISE EXCEPTION 'slice input missing'; END IF;
 RETURN jsonb_build_object('executionId',e.request_id,'conversationId',e.conversation_id,'projectId',p.id,'roundId',r.id,'stepId',e.step_id,
 'moduleId',p.module_id,'skillId',p.skill_id,'revisionId',e.revision_id,'packageHash',r.package_hash,'workflow',r.workflow,
 'modelId',e.model_id,'providerModel',e.provider_model,'summaryModelId',e.summary_model_id,'summaryProviderModel',e.summary_provider_model,
 'summaryMaxTokens',e.summary_max_tokens,'preferenceRefs',e.preference_refs,'evidenceIds',e.evidence_ids,'basis',e.basis,'body',body);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_context(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_context(uuid,uuid) TO service_role;
COMMIT;
