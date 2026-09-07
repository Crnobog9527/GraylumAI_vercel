/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Candidate delivery and existing credit RPCs share transactions. No settings,
-- models, credentials or accounts are enabled by this additive migration.
BEGIN;
CREATE TABLE IF NOT EXISTS public.artifact_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES public.artifact_projects(id),
 round_id uuid NOT NULL REFERENCES public.artifact_rounds(id), request_id uuid NOT NULL,
 step_id text NOT NULL, input jsonb NOT NULL, basis jsonb NOT NULL,
 evidence_ids jsonb NOT NULL, direct_ids jsonb NOT NULL,
 quote jsonb NOT NULL, pre_deduct_id uuid NOT NULL, dispatch_token uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','dispatched','responded','succeeded','refunded','unknown')),
 result jsonb, candidate_id uuid REFERENCES public.artifact_candidates(id),
 charged_credits integer, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,request_id),
 CHECK(octet_length(input::text)<=32768 AND octet_length(quote::text)<=16384),
 CHECK(result IS NULL OR octet_length(result::text)<=131072)
);
-- Workbench uses the existing usage statistics and daily reconciliation without
-- inventing chat conversations. Existing chat rows remain conversation-bound.
ALTER TABLE public.token_stats ADD COLUMN IF NOT EXISTS artifact_generation_id uuid REFERENCES public.artifact_generations(id);
ALTER TABLE public.token_stats ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS artifact_generation_id uuid REFERENCES public.artifact_generations(id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.token_stats'::regclass AND conname='token_stats_execution_scope') THEN
  ALTER TABLE public.token_stats ADD CONSTRAINT token_stats_execution_scope CHECK
   ((conversation_id IS NOT NULL AND artifact_generation_id IS NULL) OR (conversation_id IS NULL AND artifact_generation_id IS NOT NULL));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS token_stats_artifact_generation ON public.token_stats(artifact_generation_id) WHERE artifact_generation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_logs_artifact_generation ON public.ai_usage_logs(artifact_generation_id) WHERE artifact_generation_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.artifact_generation_basis(flow jsonb,steps jsonb,step text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH RECURSIVE ancestors(id) AS (
 SELECT step UNION SELECT d FROM ancestors a,jsonb_array_elements(flow->'steps') node,jsonb_array_elements_text(node->'dependsOn') d WHERE node->>'id'=a.id)
 SELECT jsonb_object_agg(a.id,jsonb_build_object('version',steps->a.id->'version','reviewVersion',steps->a.id->'reviewVersion')) FROM ancestors a
$$;
REVOKE ALL ON FUNCTION public.artifact_generation_basis(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.artifact_generation_inputs_current(flow jsonb,steps jsonb,step text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH RECURSIVE ancestors(id) AS (
 SELECT step UNION SELECT d FROM ancestors a,jsonb_array_elements(flow->'steps') node,jsonb_array_elements_text(node->'dependsOn') d WHERE node->>'id'=a.id)
 SELECT NOT EXISTS(SELECT 1 FROM ancestors a WHERE NOT (coalesce(steps->a.id->'provenanceIds','[]') <@ artifact_step_evidence(flow,steps,step)))
$$;
REVOKE ALL ON FUNCTION public.artifact_generation_inputs_current(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.artifact_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_generations FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS artifact_generations_round ON public.artifact_generations(round_id,created_at);
CREATE OR REPLACE FUNCTION public.artifact_generation_public(o public.artifact_generations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('requestId',o.request_id,'stepId',o.step_id,'state',o.state,
 'reservedCredits',(o.quote->>'reservedCredits')::integer,'chargedCredits',o.charged_credits,
 'candidateId',o.candidate_id,'createdAt',o.created_at)
$$;
-- Server-only. Caller identity is verified by the authenticated host; ordinary
-- roles cannot invoke this function or read private operation/context records.
CREATE OR REPLACE FUNCTION public.artifact_generation(p_actor_id uuid,p_project_id uuid,p_round_id uuid,
 p_action text,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE;
 o public.artifact_generations%ROWTYPE; spec jsonb; actual jsonb; evidence jsonb;
 token uuid:=gen_random_uuid(); pre uuid; candidate uuid; receipt jsonb; charge integer; spend uuid;
BEGIN
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='list' THEN
  RETURN (SELECT coalesce(jsonb_agg(artifact_generation_public(g) ORDER BY created_at),'[]') FROM artifact_generations g WHERE round_id=r.id);
 END IF;
 SELECT * INTO o FROM artifact_generations WHERE project_id=p.id AND request_id=p_request_id;
 IF o.id IS NOT NULL AND o.round_id<>r.id THEN RAISE EXCEPTION 'generation conflict'; END IF;
 IF p_action='abandon' THEN
  -- Serialize a no-reservation tombstone against delayed original requests.
  IF o.id IS NOT NULL THEN RETURN '{"abandoned":false}'; END IF;
  INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
   VALUES(p.id,p_request_id,r.id,'generation_abandoned','{}','{}') ON CONFLICT DO NOTHING;
  RETURN '{"abandoned":true}';
 END IF;
 IF p_action='recovery_key' THEN
  IF o.id IS NULL OR o.state NOT IN ('dispatched','unknown','responded','succeeded') THEN RAISE EXCEPTION 'generation unavailable'; END IF;
  RETURN jsonb_build_object('token',o.dispatch_token,'status',artifact_generation_public(o));
 END IF;
 IF p_action='get' THEN
  IF o.id IS NULL THEN RETURN 'null'; END IF;
  IF o.input IS DISTINCT FROM p_payload->'input' THEN RAISE EXCEPTION 'generation conflict'; END IF;
  RETURN artifact_generation_public(o);
 END IF;
 -- Recovered results can be finalized without redispatch or reopening revoked
 -- private method content. Ownership/profile checks still apply above.
 IF p_action IN ('receipt','settle','refund','cancel','unknown') THEN
  IF o.id IS NULL THEN RAISE EXCEPTION 'generation unavailable'; END IF;
  IF p_action='receipt' THEN
   IF o.state='responded' AND o.result IS NOT DISTINCT FROM p_payload->'result' THEN RETURN artifact_generation_public(o); END IF;
   IF o.state NOT IN ('dispatched','unknown') OR o.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RAISE EXCEPTION 'generation conflict'; END IF;
   receipt:=p_payload->'result';
   IF (jsonb_typeof(receipt)='object' AND jsonb_typeof(receipt->'body')='string'
    AND char_length(receipt->>'body') BETWEEN 1 AND 20000
    AND (receipt->>'inputTokens')::integer BETWEEN 0 AND 2000000
    AND (receipt->>'outputTokens')::integer BETWEEN 0 AND 2000000
    AND (receipt->>'credits')::integer BETWEEN 0 AND (o.quote->>'reservedCredits')::integer) IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'invalid receipt'; END IF;
   UPDATE artifact_generations SET state='responded',result=receipt WHERE id=o.id RETURNING * INTO o;
  ELSIF p_action='settle' THEN
   IF o.state='succeeded' THEN RETURN artifact_generation_public(o); END IF;
   IF o.state<>'responded' THEN RAISE EXCEPTION 'generation not recoverable'; END IF;
   candidate:=gen_random_uuid(); charge:=(o.result->>'credits')::integer;
   -- Retain a late result as a candidate even if the round has since closed.
   -- Its frozen provenance is never recalculated from changed dependency text.
   INSERT INTO artifact_candidates(id,round_id,step_id,body,evidence_ids)
    VALUES(candidate,r.id,o.step_id,o.result->>'body',o.evidence_ids);
   INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
    VALUES(p.id,o.id,r.id,'candidate',jsonb_build_object('stepId',o.step_id,'body',o.result->>'body',
     'evidenceIds',o.direct_ids,'generationBasis',o.basis),jsonb_build_object('candidateId',candidate));
   PERFORM atomic_settle(p_actor_id,o.pre_deduct_id,charge,
    jsonb_build_object('inputTokens',o.result->'inputTokens','outputTokens',o.result->'outputTokens',
     'generationId',o.id,'pricing',jsonb_build_object('modelId',o.quote->'modelId','providerModel',o.quote->'providerModel',
      'rates',o.quote->'pricing','settings',o.quote->'settings'),'calculatedModelCostUsd',o.result->'costUsd'),
    jsonb_build_object('generationId',o.id,'candidateId',candidate));
   IF charge>0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,counts_as_spend,source_type,source_id,idempotency_key,metadata)
     VALUES(p_actor_id,-charge,'deduction','Workbench AI generation','spend','ai_task_spend',true,'ai_task',o.id::text,
      'workbench_generation:'||o.id::text,jsonb_build_object('generationId',o.id)) RETURNING id INTO spend;
    UPDATE billing_history SET transaction_id=spend WHERE user_id=p_actor_id AND operation_type='settle' AND metadata->>'preDeductId'=o.pre_deduct_id::text;
   END IF;
   INSERT INTO token_stats(artifact_generation_id,user_id,model_used,input_tokens,output_tokens,
    cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
    VALUES(o.id,p_actor_id,o.quote->>'providerModel',(o.result->>'inputTokens')::integer,(o.result->>'outputTokens')::integer,
     0,0,0,(o.result->>'costUsd')::numeric,charge,jsonb_build_object('generationId',o.id,'pricing',o.quote->'pricing'));
   INSERT INTO ai_usage_logs(artifact_generation_id,user_id,request_id,model_id,status,metadata)
    VALUES(o.id,p_actor_id,o.request_id::text,o.quote->>'providerModel','success',jsonb_build_object('generationId',o.id));
   UPDATE artifact_generations SET state='succeeded',candidate_id=candidate,charged_credits=charge WHERE id=o.id RETURNING * INTO o;
  ELSIF p_action IN ('refund','cancel') THEN
   IF o.state='refunded' THEN RETURN artifact_generation_public(o); END IF;
   -- Only an operation proven not dispatched can be refunded automatically.
   IF o.state<>'prepared' OR (p_action='refund' AND o.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid) THEN RAISE EXCEPTION 'generation conflict'; END IF;
   PERFORM atomic_refund(p_actor_id,o.pre_deduct_id,'Workbench generation not dispatched');
   UPDATE artifact_generations SET state='refunded',charged_credits=0 WHERE id=o.id RETURNING * INTO o;
  ELSE
   IF o.state='dispatched' AND o.dispatch_token IS NOT DISTINCT FROM (p_payload->>'token')::uuid THEN
    UPDATE artifact_generations SET state='unknown' WHERE id=o.id RETURNING * INTO o;
   END IF;
  END IF;
  RETURN artifact_generation_public(o);
 END IF;
 -- All new spending/dispatch checks live execution authority under project lock.
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,r.package_hash,'');
 IF r.workflow->>'kind'='social' AND NOT EXISTS(SELECT 1 FROM artifact_accounts WHERE actor_id=p_actor_id AND module_id=p.module_id AND skill_id=p.skill_id AND account=p.account)
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF r.state<>'draft' THEN RAISE EXCEPTION 'generation round closed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='v3_workbench_ai' AND value='true'::jsonb)
 THEN RAISE EXCEPTION 'generation disabled'; END IF;
 IF NOT EXISTS(SELECT 1 FROM modules m JOIN ai_models a ON a.id=m.model_id
  WHERE m.id=p.module_id AND a.is_active='true' AND a.id::text=coalesce(o.quote,p_payload->'quote')->>'modelId')
 THEN RAISE EXCEPTION 'generation model unavailable'; END IF;
 IF p_action='prepare' THEN
  IF EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p.id AND request_id=p_request_id) THEN RAISE EXCEPTION 'generation abandoned'; END IF;
  IF o.id IS NOT NULL THEN
   IF o.input IS DISTINCT FROM p_payload->'input' THEN RAISE EXCEPTION 'generation conflict'; END IF;
   IF o.state<>'prepared' THEN RETURN artifact_generation_public(o); END IF;
   UPDATE artifact_generations SET dispatch_token=token WHERE id=o.id RETURNING * INTO o;
   RETURN artifact_generation_public(o)||jsonb_build_object('token',token);
  END IF;
  SELECT s INTO spec FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=p_payload#>>'{input,stepId}';
  IF spec IS NULL THEN RAISE EXCEPTION 'invalid generation step'; END IF;
  actual:=artifact_generation_basis(r.workflow,r.steps,spec->>'id');
  IF actual IS DISTINCT FROM (SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_payload#>'{input,expectedSteps}') WHERE actual ? key) THEN RAISE EXCEPTION 'generation input changed'; END IF;
  IF EXISTS(SELECT 1 FROM artifact_generations WHERE project_id=p.id AND state IN ('prepared','dispatched','unknown','responded')) THEN RAISE EXCEPTION 'generation pending'; END IF;
  IF (SELECT count(*) FROM artifact_candidates WHERE round_id=r.id)+(SELECT count(*) FROM artifact_generations WHERE round_id=r.id AND candidate_id IS NULL)>=256 THEN RAISE EXCEPTION 'generation capacity'; END IF;
  IF NOT artifact_generation_inputs_current(r.workflow,r.steps,spec->>'id') THEN RAISE EXCEPTION 'generation provenance changed'; END IF;
  evidence:=artifact_step_evidence(r.workflow,r.steps,spec->>'id');
  IF NOT artifact_evidence_allowed(p.id,evidence) THEN RAISE EXCEPTION 'generation evidence unavailable'; END IF;
  IF (spec->>'requiresEvidence')::boolean AND jsonb_array_length(evidence)=0 THEN RAISE EXCEPTION 'generation evidence required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(spec->'dependsOn') d WHERE (r.steps->d->>'valid')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'generation dependencies unconfirmed'; END IF;
  IF ((p_payload#>>'{quote,reservedCredits}')::integer BETWEEN 1 AND 1000000
    AND (p_payload#>>'{quote,reservedCredits}')::integer <= (p_payload#>>'{input,budgetCredits}')::integer) IS DISTINCT FROM true THEN RAISE EXCEPTION 'generation budget'; END IF;
  SELECT pre_deduct_id INTO pre FROM atomic_pre_deduct(p_actor_id,(p_payload#>>'{quote,reservedCredits}')::integer,'Workbench generation',gen_random_uuid());
  INSERT INTO artifact_generations(project_id,round_id,request_id,step_id,input,basis,evidence_ids,direct_ids,quote,pre_deduct_id,dispatch_token,state)
   VALUES(p.id,r.id,p_request_id,spec->>'id',p_payload->'input',actual,evidence,coalesce(r.steps->(spec->>'id')->'evidenceIds','[]'),p_payload->'quote',pre,token,'prepared') RETURNING * INTO o;
  RETURN artifact_generation_public(o)||jsonb_build_object('token',token);
 ELSIF p_action='dispatch' THEN
  IF o.id IS NULL OR o.state<>'prepared' OR o.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RETURN '{"dispatch":false}'; END IF;
  actual:=artifact_generation_basis(r.workflow,r.steps,o.step_id);
  IF actual IS DISTINCT FROM o.basis OR NOT artifact_generation_inputs_current(r.workflow,r.steps,o.step_id) OR NOT artifact_evidence_allowed(p.id,o.evidence_ids) THEN RAISE EXCEPTION 'generation input changed'; END IF;
  UPDATE artifact_generations SET state='dispatched' WHERE id=o.id;
  RETURN '{"dispatch":true}';
 END IF;
 RAISE EXCEPTION 'generation action denied';
END $$;
REVOKE ALL ON FUNCTION public.artifact_generation_public(public.artifact_generations) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.artifact_generation(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_generation(uuid,uuid,uuid,text,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.artifact_save_candidate(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
 p_project_id uuid,p_round_id uuid,p_request_id uuid,p_step_id text,p_candidate_id uuid,p_expected_version integer,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; candidate public.artifact_candidates%ROWTYPE; direct_ids jsonb; effective_ids jsonb; flow jsonb; payload jsonb;
BEGIN
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id FOR UPDATE;
 snapshot:=artifact_transition(p_actor_id,p_module_id,p_skill_id,'read',p_project_id,p_round_id);
 SELECT * INTO candidate FROM artifact_candidates WHERE id=p_candidate_id AND round_id=p_round_id AND step_id=p_step_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT q.payload->'evidenceIds' INTO direct_ids FROM artifact_requests q WHERE q.project_id=p_project_id AND q.round_id=p_round_id
  AND q.action='candidate' AND q.response->>'candidateId'=p_candidate_id::text;
 IF direct_ids IS NULL OR jsonb_array_length(direct_ids)>64 THEN RAISE EXCEPTION 'candidate inputs unavailable'; END IF;
 payload:=jsonb_build_object('stepId',p_step_id,'candidateId',p_candidate_id,'expectedVersion',p_expected_version,'body',p_body,'evidenceIds',direct_ids);
 IF NOT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) THEN
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
CREATE OR REPLACE FUNCTION public.artifact_query(p_actor_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE; w public.artifact_workflows%ROWTYPE;
 result jsonb:='[]'; descriptor jsonb; snapshot jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='catalog' THEN
  IF (SELECT count(*) FROM artifact_workflows WHERE enabled)>100 THEN RAISE EXCEPTION 'registry capacity'; END IF;
  FOR w IN SELECT * FROM artifact_workflows WHERE enabled ORDER BY id LIMIT 100 LOOP
   BEGIN
    descriptor:=read_skill_package(p_actor_id,w.module_id,w.skill_id,w.revision_id,NULL,NULL);
    PERFORM artifact_validate_workflow(w.workflow,descriptor);
    result:=result||jsonb_build_array(jsonb_build_object('id',w.id,'label',w.label,'moduleId',w.module_id,'skillId',w.skill_id,
     'revisionId',w.revision_id,'packageHash',descriptor->>'packageHash','workflow',w.workflow,
     'accounts',(SELECT coalesce(jsonb_agg(account ORDER BY account),'[]') FROM artifact_accounts WHERE actor_id=p_actor_id AND module_id=w.module_id AND skill_id=w.skill_id)));
   EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
    WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF;
   END;
  END LOOP;
  RETURN result;
 ELSIF p_action='projects' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',id,'moduleId',module_id,'skillId',skill_id,'account',account,'title',coalesce((SELECT a.workflow->'report'->>'title' FROM artifact_rounds a WHERE a.project_id=ap.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'已保存项目'),'currentVersion',current_version,'createdAt',created_at) ORDER BY created_at,id),'[]') FROM artifact_projects ap WHERE actor_id=p_actor_id);
 END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='rounds' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('roundId',a.id,'state',a.state,'revisionId',a.revision_id,'packageHash',a.package_hash,
    'workflowHash',a.workflow_hash,'templateHash',a.template_hash,'version',v.version,'createdAt',a.created_at) ORDER BY a.created_at,a.id),'[]')
   FROM artifact_rounds a LEFT JOIN artifact_versions v ON v.round_id=a.id WHERE a.project_id=p.id);
 END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='resolve' THEN
  RETURN jsonb_build_object('moduleId',p.module_id,'skillId',p.skill_id,'account',p.account,'revisionId',r.revision_id,'workflow',r.workflow);
 ELSIF p_action='read' THEN
  snapshot:=artifact_transition(p_actor_id,p.module_id,p.skill_id,'read',p.id,r.id);
  -- Direct candidate inputs are retained in immutable request records. The
  -- candidate's evidenceIds remain the complete inherited provenance.
  snapshot:=snapshot||jsonb_build_object('candidates',(SELECT coalesce(jsonb_agg(c||jsonb_build_object('directEvidenceIds',
   (SELECT q.payload->'evidenceIds' FROM artifact_requests q WHERE q.project_id=p.id AND q.round_id=r.id
    AND q.action='candidate' AND q.response->>'candidateId'=c->>'id' LIMIT 1))),'[]')
   FROM jsonb_array_elements(snapshot->'candidates') c));
  RETURN snapshot||jsonb_build_object('generations',(SELECT coalesce(jsonb_agg(artifact_generation_public(g) ORDER BY created_at),'[]') FROM artifact_generations g WHERE round_id=r.id),'workflow',jsonb_build_object('id',r.workflow->>'id','version',r.workflow->'version','kind',r.workflow->>'kind',
   'report',r.workflow->'report','steps',(SELECT jsonb_agg(jsonb_build_object('id',x->>'id','title',x->>'title','dependsOn',x->'dependsOn',
    'minLength',x->'minLength','maxLength',x->'maxLength','requiresEvidence',x->'requiresEvidence') ORDER BY n)
    FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY t(x,n))));
 END IF;
 RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501';
END $$;
COMMIT;
