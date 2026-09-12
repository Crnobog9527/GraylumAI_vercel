/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Conversation is presentation identity; each selected method executes against
-- an immutable existing project/round. User input lives in artifact_requests.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_slice_executions (
 request_id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES public.conversations(id),
 project_id uuid NOT NULL REFERENCES public.artifact_projects(id),
 round_id uuid NOT NULL REFERENCES public.artifact_rounds(id),
 step_id text NOT NULL,
 revision_id uuid NOT NULL REFERENCES public.skill_packages(revision_id),
 pair_id text NOT NULL REFERENCES public.agent_slice_pairs(id),
 model_id uuid NOT NULL REFERENCES public.ai_models(id),
 provider_model text NOT NULL,
 budget_credits integer NOT NULL CHECK(budget_credits BETWEEN 1 AND 1000000),
 evidence_ids jsonb NOT NULL,
 basis jsonb NOT NULL,
 preference_refs jsonb NOT NULL CHECK(jsonb_typeof(preference_refs)='array' AND jsonb_array_length(preference_refs)<=40),
 input_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,request_id) REFERENCES public.artifact_requests(project_id,request_id)
);
ALTER TABLE public.agent_slice_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_slice_executions FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS agent_slice_execution_conversation ON public.agent_slice_executions(conversation_id,created_at,request_id);
DROP TRIGGER IF EXISTS artifact_immutable ON public.agent_slice_executions;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.agent_slice_executions FOR EACH ROW EXECUTE FUNCTION public.artifact_immutable();

CREATE OR REPLACE FUNCTION public.agent_slice_preferences_valid(p_actor_id uuid,refs jsonb,p_account text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN false ELSE jsonb_array_length(refs)<=40
 AND jsonb_array_length(refs)=(SELECT count(DISTINCT (ref->>'scope',ref->>'name')) FROM jsonb_array_elements(refs) ref) AND
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) ref LEFT JOIN agent_confirmed_preferences p
 ON p.actor_id=p_actor_id AND p.scope_key=ref->>'scope' AND p.name=ref->>'name'
 WHERE p.actor_id IS NULL OR NOT p.active OR p.version::text IS DISTINCT FROM ref->>'version'
 OR (p.scope_key<>'user' AND p.scope_key IS DISTINCT FROM 'account:'||p_account)
 OR (ref-'scope'-'name'-'version')<>'{}'::jsonb) END
$$;
REVOKE ALL ON FUNCTION public.agent_slice_preferences_valid(uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.agent_slice_begin(p_actor_id uuid,p_conversation_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;cfg agent_slice_pairs%ROWTYPE;
 a artifact_workflows%ROWTYPE;b artifact_workflows%ROWTYPE;prior agent_slice_executions%ROWTYPE;
 ev jsonb;refs jsonb:=coalesce(p_payload->'preferenceRefs','[]');model_name text;account_name text;body text:=p_payload->>'body';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM artifact_chats WHERE conversation_id=p_conversation_id) THEN RAISE EXCEPTION 'slice conversation denied'; END IF;
 SELECT * INTO prior FROM agent_slice_executions WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.conversation_id<>p_conversation_id OR prior.input_hash<>artifact_hash(p_payload) THEN RAISE EXCEPTION 'slice execution conflict'; END IF;
  RETURN jsonb_build_object('requestId',prior.request_id,'projectId',prior.project_id,'roundId',prior.round_id,'revisionId',prior.revision_id);
 END IF;
 IF body IS NULL OR char_length(btrim(body)) NOT BETWEEN 1 AND 2000 OR (p_payload-'projectId'-'roundId'-'stepId'-'pairId'-'modelId'-'budgetCredits'-'body'-'preferenceRefs')<>'{}' THEN RAISE EXCEPTION 'slice input invalid'; END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=(p_payload->>'projectId')::uuid AND actor_id=p_actor_id AND work_kind='script' FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=(p_payload->>'roundId')::uuid AND project_id=p.id AND state='draft';
 IF p.id IS NULL OR r.id IS NULL OR NOT (r.steps ? (p_payload->>'stepId')) THEN RAISE EXCEPTION 'slice target denied'; END IF;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=p_payload->>'pairId' AND enabled FOR SHARE;
 SELECT * INTO a FROM artifact_workflows WHERE id=cfg.script_workflow AND enabled;
 SELECT * INTO b FROM artifact_workflows WHERE id=cfg.title_workflow AND enabled;
 IF cfg.id IS NULL OR a.id IS NULL OR b.id IS NULL OR ((p.module_id=a.module_id AND p.skill_id=a.skill_id AND r.workflow->>'id'=a.workflow->>'id')
  OR (p.module_id=b.module_id AND p.skill_id=b.skill_id AND r.workflow->>'id'=b.workflow->>'id')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'slice method denied'; END IF;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,NULL,NULL);
 SELECT am.model_id INTO model_name FROM ai_models am JOIN modules m ON m.model_id=am.id
  WHERE m.id=p.module_id AND am.id=(p_payload->>'modelId')::uuid AND am.is_active='true' AND am.model_id !~* '(^openai/|gpt)';
 IF model_name IS NULL THEN RAISE EXCEPTION 'slice model unavailable'; END IF;
 SELECT root.account INTO account_name FROM artifact_projects root WHERE root.id=p.source_project_id;
 IF account_name IS NULL OR NOT agent_slice_preferences_valid(p_actor_id,refs,account_name) THEN RAISE EXCEPTION 'slice preference changed'; END IF;
 ev:=artifact_step_evidence(r.workflow,r.steps,p_payload->>'stepId');
 IF NOT artifact_evidence_allowed(p.id,ev) OR NOT artifact_generation_inputs_current(r.workflow,r.steps,p_payload->>'stepId') THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
  VALUES(p.id,p_request_id,r.id,'slice_input',jsonb_build_object('body',body,'evidenceIds',ev),'{}');
 INSERT INTO agent_slice_executions(request_id,conversation_id,project_id,round_id,step_id,revision_id,pair_id,model_id,provider_model,budget_credits,evidence_ids,basis,preference_refs,input_hash)
  VALUES(p_request_id,p_conversation_id,p.id,r.id,p_payload->>'stepId',r.revision_id,cfg.id,(p_payload->>'modelId')::uuid,model_name,(p_payload->>'budgetCredits')::integer,ev,artifact_generation_basis(r.workflow,r.steps,p_payload->>'stepId'),refs,artifact_hash(p_payload));
 RETURN jsonb_build_object('requestId',p_request_id,'projectId',p.id,'roundId',r.id,'revisionId',r.revision_id);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
