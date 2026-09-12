/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Reuse candidates as the only body store and requests as phase identity.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS agent_slice_result_identity ON public.artifact_requests((payload->>'sliceExecution'),(payload->>'slicePhase')) WHERE action='candidate' AND payload ? 'sliceExecution';
CREATE OR REPLACE FUNCTION public.agent_slice_result(p_actor_id uuid,p_execution_id uuid,p_phase text,p_action text,p_body text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE;p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;q artifact_requests%ROWTYPE;c artifact_candidates%ROWTYPE;
 ident uuid:=gen_random_uuid();limit_chars integer;allowed boolean;
BEGIN
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id FOR UPDATE;
 SELECT * INTO p FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id FOR UPDATE;
 IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
  OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=e.conversation_id AND user_id=p_actor_id AND is_deleted='false')
 THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 IF p_phase NOT IN ('reply','summary') OR p_phase IS NULL OR p_action NOT IN ('read','save') OR p_action IS NULL THEN RAISE EXCEPTION 'slice result invalid'; END IF;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,e.revision_id,NULL,NULL);
 SELECT * INTO r FROM artifact_rounds WHERE id=e.round_id AND project_id=p.id;
 allowed:=artifact_evidence_allowed(p.id,e.evidence_ids);
 IF NOT allowed THEN RETURN jsonb_build_object('state','restricted'); END IF;
 SELECT * INTO q FROM artifact_requests WHERE project_id=p.id AND action='candidate' AND payload->>'sliceExecution'=e.request_id::text AND payload->>'slicePhase'=p_phase;
 IF q.request_id IS NOT NULL THEN
  SELECT * INTO c FROM artifact_candidates WHERE id=(q.response->>'candidateId')::uuid AND round_id=e.round_id AND step_id=e.step_id;
  IF c.id IS NULL OR NOT artifact_evidence_allowed(p.id,c.evidence_ids) THEN RETURN jsonb_build_object('state','restricted'); END IF;
  IF p_action='save' AND c.body IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'slice result conflict'; END IF;
 ELSIF p_action='read' THEN RETURN jsonb_build_object('state','pending');
 ELSE
  IF NOT EXISTS(SELECT 1 FROM agent_slice_calls WHERE execution_id=e.request_id AND phase=p_phase AND state IN ('responded','settled') AND evidence->>'outcome'='responded' AND evidence->>'finishReason'='stop') THEN RAISE EXCEPTION 'slice result unknown'; END IF;
  SELECT CASE WHEN p_phase='reply' THEN 20000 ELSE (s->>'maxLength')::integer END INTO limit_chars FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=e.step_id;
  IF p_body IS NULL OR char_length(btrim(p_body)) NOT BETWEEN 1 AND limit_chars OR limit_chars IS NULL THEN RAISE EXCEPTION 'slice result invalid'; END IF;
  IF (SELECT count(*) FROM artifact_candidates WHERE round_id=r.id)>=256 THEN RAISE EXCEPTION 'candidate capacity'; END IF;
  INSERT INTO artifact_candidates(id,round_id,step_id,body,evidence_ids) VALUES(ident,r.id,e.step_id,p_body,e.evidence_ids) RETURNING * INTO c;
  INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
   VALUES(p.id,ident,r.id,'candidate',jsonb_build_object('stepId',e.step_id,'evidenceIds',e.evidence_ids,'sliceExecution',e.request_id,'slicePhase',p_phase),jsonb_build_object('candidateId',ident));
 END IF;
 RETURN jsonb_build_object('state','saved','candidateId',c.id,'body',c.body,'projectId',p.id,'roundId',r.id,'stepId',e.step_id,
  'adoptable',p_phase='summary' AND r.state='draft' AND artifact_generation_basis(r.workflow,r.steps,e.step_id)=e.basis);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.artifact_save_candidate(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
 p_project_id uuid,p_round_id uuid,p_request_id uuid,p_step_id text,p_candidate_id uuid,p_expected_version integer,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; candidate public.artifact_candidates%ROWTYPE; direct_ids jsonb; effective_ids jsonb; flow jsonb; payload jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM artifact_generations WHERE candidate_id=p_candidate_id AND input->>'purpose'='reply') THEN RAISE EXCEPTION 'reply is not a step result' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM artifact_requests q JOIN agent_slice_executions e ON e.request_id::text=q.payload->>'sliceExecution'
  JOIN artifact_rounds r ON r.id=e.round_id WHERE q.action='candidate' AND q.response->>'candidateId'=p_candidate_id::text
  AND (q.payload->>'slicePhase'='reply' OR (NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) AND e.basis IS DISTINCT FROM artifact_generation_basis(r.workflow,r.steps,e.step_id))))
 THEN RAISE EXCEPTION 'slice candidate input changed' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 snapshot:=artifact_transition(p_actor_id,p_module_id,p_skill_id,'read',p_project_id,p_round_id);
 SELECT * INTO candidate FROM artifact_candidates WHERE id=p_candidate_id AND round_id=p_round_id AND step_id=p_step_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT q.payload->'evidenceIds' INTO direct_ids FROM artifact_requests q WHERE q.project_id=p_project_id AND q.round_id=p_round_id
  AND q.action='candidate' AND q.response->>'candidateId'=p_candidate_id::text;
 IF direct_ids IS NULL OR jsonb_array_length(direct_ids)>64 THEN RAISE EXCEPTION 'candidate inputs unavailable'; END IF;
 payload:=jsonb_build_object('stepId',p_step_id,'candidateId',p_candidate_id,'expectedVersion',p_expected_version,'body',p_body,'evidenceIds',direct_ids);
 IF NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
  IF snapshot->>'state' <> 'draft' THEN RAISE EXCEPTION 'candidate input changed'; END IF;
  IF EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p_project_id AND ar.action='summary_dismissed' AND ar.payload->>'candidateId'=p_candidate_id::text) THEN RAISE EXCEPTION 'summary dismissed'; END IF;
  SELECT workflow INTO flow FROM artifact_rounds WHERE id=p_round_id;
  -- Only contributing step/ancestor versions invalidate an AI candidate.
  IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.candidate_id=p_candidate_id
    AND g.basis IS DISTINCT FROM artifact_generation_basis(flow,snapshot->'steps',p_step_id))
  THEN RAISE EXCEPTION 'candidate input changed'; END IF;
  SELECT workflow INTO flow FROM artifact_rounds WHERE id=p_round_id;
  effective_ids:=artifact_step_evidence(flow,jsonb_set(snapshot->'steps',ARRAY[p_step_id,'evidenceIds'],direct_ids),p_step_id);
  IF NOT (candidate.evidence_ids <@ effective_ids) OR NOT artifact_evidence_allowed(p_project_id,candidate.evidence_ids) THEN
   RAISE EXCEPTION 'candidate provenance changed';
  END IF;
 END IF;
 RETURN artifact_transition(p_actor_id,p_module_id,p_skill_id,'save',p_project_id,p_round_id,p_request_id,payload);
END $$;
COMMIT;
