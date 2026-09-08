/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Separate durable reply/summary identities; no model or enable configuration is seeded.
BEGIN;
ALTER TABLE public.artifact_chat_turns ADD COLUMN IF NOT EXISTS generation_mode text NOT NULL DEFAULT 'legacy' CHECK(generation_mode IN ('legacy','dual'));
ALTER TABLE public.artifact_chat_turns ALTER COLUMN generation_mode SET DEFAULT 'dual';
CREATE TABLE IF NOT EXISTS public.artifact_chat_summaries (
 turn_id uuid NOT NULL REFERENCES public.artifact_chat_turns(request_id) ON DELETE CASCADE,
 request_id uuid PRIMARY KEY CHECK(request_id<>turn_id),
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 8),
 UNIQUE(turn_id,attempt)
);
ALTER TABLE public.artifact_chat_summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_chat_summaries FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.artifact_chat_summaries DROP CONSTRAINT IF EXISTS artifact_chat_summaries_turn_id_fkey;
ALTER TABLE public.artifact_chat_summaries ADD CONSTRAINT artifact_chat_summaries_turn_id_fkey FOREIGN KEY(turn_id) REFERENCES public.artifact_chat_turns(request_id) ON DELETE CASCADE;
DROP TRIGGER IF EXISTS artifact_immutable ON public.artifact_chat_summaries;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.artifact_chat_summaries FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_history_immutable();
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
     'generationId',o.id,'role',coalesce(o.input->>'purpose','legacy'),'pricing',jsonb_build_object('modelId',o.quote->'modelId','providerModel',o.quote->'providerModel',
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
     0,0,0,(o.result->>'costUsd')::numeric,charge,jsonb_build_object('generationId',o.id,'role',coalesce(o.input->>'purpose','legacy'),'pricing',o.quote->'pricing'));
   INSERT INTO ai_usage_logs(artifact_generation_id,user_id,request_id,model_id,status,metadata)
    VALUES(o.id,p_actor_id,o.request_id::text,o.quote->>'providerModel','success',jsonb_build_object('generationId',o.id,'role',coalesce(o.input->>'purpose','legacy')));
   UPDATE artifact_generations SET state='succeeded',candidate_id=candidate,charged_credits=charge WHERE id=o.id RETURNING * INTO o;
  ELSIF p_action IN ('refund','cancel') THEN
   IF o.state='refunded' THEN RETURN artifact_generation_public(o); END IF;
   -- Only an operation proven not dispatched can be refunded automatically.
   IF o.state<>'prepared' OR (p_action='refund' AND o.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid) THEN RAISE EXCEPTION 'generation conflict'; END IF;
   PERFORM atomic_refund(p_actor_id,o.pre_deduct_id,'Workbench generation not dispatched');
   UPDATE artifact_generations SET state='refunded',charged_credits=0 WHERE id=o.id RETURNING * INTO o;
  ELSE
   IF o.state='dispatched' AND o.dispatch_token IS NOT DISTINCT FROM (p_payload->>'token')::uuid THEN
    IF p_payload ? 'exceededUsage' THEN
     IF jsonb_typeof(p_payload->'exceededUsage')<>'object'
      OR coalesce((p_payload->'exceededUsage'->>'inputTokens')::integer,-1) NOT BETWEEN 0 AND 2000000
      OR coalesce((p_payload->'exceededUsage'->>'outputTokens')::integer,-1) NOT BETWEEN 0 AND 2000000
     THEN RAISE EXCEPTION 'invalid usage evidence'; END IF;
     INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
      VALUES(p.id,gen_random_uuid(),r.id,'generation_usage_exceeded',jsonb_build_object('generationId',o.id,
       'inputTokens',p_payload->'exceededUsage'->'inputTokens','outputTokens',p_payload->'exceededUsage'->'outputTokens',
       'reservedInputTokens',o.quote->'inputTokens','providerModel',o.quote->'providerModel'),'{}');
    END IF;
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
 IF NOT EXISTS(SELECT 1 FROM modules m JOIN ai_models primary_model ON primary_model.id=m.model_id JOIN ai_models a ON a.id::text=coalesce(o.quote,p_payload->'quote')->>'modelId'
  WHERE m.id=p.module_id AND primary_model.is_active='true' AND a.is_active='true' AND
  CASE WHEN coalesce(o.input,p_payload->'input')->>'purpose'='summary'
   THEN a.id::text=(SELECT value#>>'{}' FROM system_settings WHERE key='v3_summary_model_id') AND a.id<>primary_model.id AND lower(trim(a.model_id))<>lower(trim(primary_model.model_id))
   ELSE a.id=primary_model.id END)
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

CREATE OR REPLACE FUNCTION public.artifact_chat(p_actor_id uuid,p_action text,p_conversation_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE; c public.artifact_chats%ROWTYPE;
 t public.artifact_chat_turns%ROWTYPE; ids jsonb; turns jsonb; context_basis jsonb; frozen_turn_ids jsonb; result jsonb; latest_summary public.artifact_chat_summaries%ROWTYPE;
BEGIN
 IF p_payload IS NULL OR octet_length(p_payload::text)>32768 OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='stats' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('conversationId',ch.conversation_id,
   'messageCount',(SELECT count(*)+count(g.candidate_id) FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=ch.project_id AND g.round_id=ch.round_id AND g.request_id=a.request_id WHERE a.conversation_id=ch.conversation_id),
   'creditsUsed',(SELECT coalesce(sum(total_credits),0) FROM token_stats ts JOIN artifact_generations g ON ts.artifact_generation_id=g.id WHERE g.project_id=ch.project_id AND g.round_id=ch.round_id))),'[]')
   FROM artifact_chats ch JOIN artifact_projects ap ON ap.id=ch.project_id WHERE ap.actor_id=p_actor_id);
 END IF;
 IF p_action='mode' THEN
  IF NOT EXISTS(SELECT 1 FROM modules m JOIN skills s ON s.id=m.skill_id WHERE m.id=(p_payload->>'moduleId')::uuid AND m.active AND s.status='published') THEN RAISE EXCEPTION 'module unavailable' USING ERRCODE='42501'; END IF;
  -- A disabled current workflow stays guided/unavailable: do not silently run
  -- its Skill as a plain text method. Historical bindings do not classify a new Skill.
  RETURN jsonb_build_object('guided',EXISTS(SELECT 1 FROM artifact_workflows w JOIN modules m ON m.id=w.module_id AND m.skill_id=w.skill_id WHERE w.module_id=(p_payload->>'moduleId')::uuid));
 END IF;
 IF p_action='attach' THEN
  SELECT * INTO p FROM artifact_projects WHERE id=(p_payload->>'projectId')::uuid AND actor_id=p_actor_id FOR UPDATE;
 ELSE
  SELECT * INTO c FROM artifact_chats WHERE conversation_id=p_conversation_id;
  SELECT * INTO p FROM artifact_projects WHERE id=c.project_id AND actor_id=p_actor_id FOR UPDATE;
 END IF;
 IF p.id IS NULL THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=CASE WHEN p_action='attach' THEN (p_payload->>'roundId')::uuid ELSE c.round_id END AND project_id=p.id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action IN ('submit','context','summary') THEN
  PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 END IF;
 IF p_action='attach' THEN
  SELECT * INTO c FROM artifact_chats WHERE round_id=r.id;
  IF c.conversation_id IS NULL THEN
   INSERT INTO conversations(id,user_id,title,skill_mode,module_id) VALUES((p_payload->>'requestId')::uuid,p_actor_id,r.workflow->'report'->>'title',true,p.module_id);
   INSERT INTO artifact_chats VALUES((p_payload->>'requestId')::uuid,p.id,r.id,r.workflow->'steps'->0->>'id') RETURNING * INTO c;
  ELSE
   UPDATE conversations SET is_deleted='false',deleted_at=NULL WHERE id=c.conversation_id AND user_id=p_actor_id AND is_deleted='true';
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=c.conversation_id AND user_id=p_actor_id AND skill_mode AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='attach' THEN RETURN artifact_chat_binding(c); END IF;
 IF p_action='dismiss_summary' THEN
  IF NOT EXISTS(SELECT 1 FROM artifact_generations g JOIN artifact_chat_summaries sm ON sm.request_id=g.request_id JOIN artifact_chat_turns ct ON ct.request_id=sm.turn_id
   WHERE g.project_id=p.id AND g.round_id=r.id AND g.candidate_id=(p_payload->>'candidateId')::uuid AND g.input->>'purpose'='summary' AND ct.conversation_id=c.conversation_id) THEN RAISE EXCEPTION 'summary denied' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p.id AND ar.action='summary_dismissed' AND ar.payload->>'candidateId'=p_payload->>'candidateId') THEN
   INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response) VALUES(p.id,gen_random_uuid(),r.id,'summary_dismissed',jsonb_build_object('candidateId',p_payload->>'candidateId'),'{"dismissed":true}');
  END IF;
  RETURN '{"dismissed":true}'::jsonb;
 END IF;
 IF p_action='summary' THEN
  SELECT * INTO t FROM artifact_chat_turns WHERE conversation_id=c.conversation_id AND request_id=(p_payload->>'requestId')::uuid AND generation_mode='dual';
  IF t.request_id IS NULL OR r.state<>'draft' OR NOT EXISTS(SELECT 1 FROM artifact_generations g WHERE g.project_id=p.id AND g.round_id=r.id AND g.request_id=t.request_id AND g.state='succeeded' AND g.input->>'purpose'='reply' AND artifact_evidence_allowed(p.id,g.evidence_ids||t.evidence_ids)) THEN RAISE EXCEPTION 'reply unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO latest_summary FROM artifact_chat_summaries WHERE turn_id=t.request_id ORDER BY attempt DESC LIMIT 1;
  -- The project lock serializes attempt allocation. Only an authoritative
  -- never-dispatched terminal result permits a new identity; retain old tombstones.
  IF latest_summary.request_id IS NULL OR EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p.id AND ar.request_id=latest_summary.request_id AND ar.action='generation_abandoned') OR EXISTS(SELECT 1 FROM artifact_generations g WHERE g.project_id=p.id AND g.round_id=r.id AND g.request_id=latest_summary.request_id AND g.state='refunded') THEN
   INSERT INTO artifact_chat_summaries(turn_id,request_id,attempt) VALUES(t.request_id,gen_random_uuid(),coalesce(latest_summary.attempt,0)+1) RETURNING * INTO latest_summary;
  END IF;
  RETURN jsonb_build_object('requestId',latest_summary.request_id,'turnId',t.request_id,'stepId',t.step_id,'body',t.body);
 END IF;
 IF p_action='select' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=p_payload->>'stepId') THEN RAISE EXCEPTION 'step denied' USING ERRCODE='42501'; END IF;
  UPDATE artifact_chats SET step_id=p_payload->>'stepId' WHERE conversation_id=c.conversation_id RETURNING * INTO c;
  RETURN artifact_chat_binding(c);
 END IF;
 IF p_action='submit' THEN
  SELECT * INTO t FROM artifact_chat_turns WHERE request_id=(p_payload->>'requestId')::uuid;
  IF t.request_id IS NOT NULL THEN
   IF t.conversation_id<>c.conversation_id OR t.step_id IS DISTINCT FROM p_payload->>'stepId' OR t.body IS DISTINCT FROM p_payload->>'body' THEN RAISE EXCEPTION 'turn conflict'; END IF;
   RETURN jsonb_build_object('requestId',t.request_id);
  END IF;
  PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF r.state<>'draft' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=p_payload->>'stepId') OR artifact_text_length(p_payload->>'body')<1 OR char_length(p_payload->>'body')>2000 THEN RAISE EXCEPTION 'invalid turn'; END IF;
  IF (SELECT count(*) FROM artifact_chat_turns WHERE conversation_id=c.conversation_id)>=256 THEN RAISE EXCEPTION 'conversation capacity'; END IF;
  ids:=artifact_step_evidence(r.workflow,r.steps,p_payload->>'stepId');
  context_basis:=artifact_generation_basis(r.workflow,r.steps,p_payload->>'stepId');
  -- Freeze the actual preceding results as well as their sources. A reply that
  -- completes after submission cannot silently enter this turn's model context.
  SELECT coalesce(jsonb_agg(a.request_id),'[]') INTO frozen_turn_ids FROM artifact_chat_turns a
   JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id
   WHERE a.conversation_id=c.conversation_id AND context_basis ? a.step_id AND g.state='succeeded'
    -- Removing a source from the rewritten step also removes dependent old
    -- discussion from new model context; readable history remains immutable.
    AND (a.evidence_ids||coalesce(g.evidence_ids,'[]')) <@ ids;
  -- Freeze sources from the same preceding discussions, including model replies.
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO ids FROM (
   SELECT jsonb_array_elements(ids) e UNION ALL
   SELECT jsonb_array_elements(a.evidence_ids||coalesce(g.evidence_ids,'[]')) FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id WHERE a.conversation_id=c.conversation_id AND frozen_turn_ids ? a.request_id::text
  ) all_sources;
  IF NOT artifact_evidence_allowed(p.id,ids) THEN RAISE EXCEPTION 'evidence denied' USING ERRCODE='42501'; END IF;
  INSERT INTO artifact_chat_turns(request_id,conversation_id,step_id,body,evidence_ids,created_at,context_turn_ids) VALUES((p_payload->>'requestId')::uuid,c.conversation_id,p_payload->>'stepId',p_payload->>'body',ids,clock_timestamp(),frozen_turn_ids);
  UPDATE artifact_chats SET step_id=p_payload->>'stepId' WHERE conversation_id=c.conversation_id;
  RETURN jsonb_build_object('requestId',p_payload->>'requestId');
 END IF;
 IF p_action IN ('read','context') THEN
  IF p_action='context' THEN
   SELECT * INTO t FROM artifact_chat_turns WHERE request_id=(p_payload->>'requestId')::uuid AND conversation_id=c.conversation_id AND step_id=p_payload->>'stepId';
   IF t.request_id IS NULL OR NOT artifact_evidence_allowed(p.id,t.evidence_ids) THEN RAISE EXCEPTION 'turn denied' USING ERRCODE='42501'; END IF;
   context_basis:=artifact_generation_basis(r.workflow,r.steps,t.step_id);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',a.request_id,'stepId',a.step_id,
   'body',CASE WHEN artifact_evidence_allowed(p.id,a.evidence_ids) THEN a.body ELSE NULL END,
   'answer',CASE WHEN artifact_evidence_allowed(p.id,a.evidence_ids||coalesce(g.evidence_ids,'[]')) THEN candidate.body ELSE NULL END,
   'available',artifact_evidence_allowed(p.id,a.evidence_ids||coalesce(g.evidence_ids,'[]')),
   'candidateId',g.candidate_id,'generationMode',a.generation_mode,'summaryRequestId',sm.request_id,'summaryState',coalesce(sg.state,'pending'),'summaryCandidateId',sg.candidate_id,'summaryBasis',sg.basis,'summaryDismissed',EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p.id AND ar.action='summary_dismissed' AND ar.payload->>'candidateId'=sg.candidate_id::text),'createdAt',a.created_at,'generationState',coalesce(g.state,'unsent'),'abandoned',EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p.id AND ar.round_id=r.id AND ar.request_id=a.request_id AND ar.action='generation_abandoned')) ORDER BY a.created_at,a.request_id),'[]') INTO turns
  FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id
  LEFT JOIN LATERAL (SELECT * FROM artifact_chat_summaries WHERE turn_id=a.request_id ORDER BY attempt DESC LIMIT 1) sm ON true
  LEFT JOIN artifact_generations sg ON sg.project_id=p.id AND sg.round_id=r.id AND sg.request_id=sm.request_id
  LEFT JOIN artifact_candidates candidate ON candidate.id=g.candidate_id
  WHERE a.conversation_id=c.conversation_id AND (p_action='read' OR (context_basis ? a.step_id AND (a.created_at,a.request_id)<=(t.created_at,t.request_id) AND (a.request_id=t.request_id OR (t.context_turn_ids ? a.request_id::text AND g.state='succeeded'))));
  IF p_action='read' THEN RETURN jsonb_build_object('binding',artifact_chat_binding(c),'turns',turns); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(turns) x WHERE x->>'available'='false') THEN RAISE EXCEPTION 'context restricted' USING ERRCODE='42501'; END IF;
  -- The current assistant response never becomes its own input on prepared retry.
  SELECT jsonb_agg(CASE WHEN x->>'requestId'=t.request_id::text THEN (x-'generationState'-'abandoned'-'summaryState'-'summaryRequestId'-'summaryCandidateId'-'summaryBasis'-'summaryDismissed')||'{"answer":null,"candidateId":null}' ELSE x-'generationState'-'abandoned'-'summaryState'-'summaryRequestId'-'summaryCandidateId'-'summaryBasis'-'summaryDismissed' END ORDER BY ord) INTO turns FROM jsonb_array_elements(turns) WITH ORDINALITY q(x,ord);
  RETURN jsonb_build_object('turns',turns,'evidenceIds',t.evidence_ids,'body',t.body,'binding',artifact_chat_binding(c),'replyModel',(SELECT jsonb_build_object('modelId',g.quote->'modelId','providerModel',g.quote->'providerModel') FROM artifact_generations g WHERE g.project_id=p.id AND g.round_id=r.id AND g.request_id=t.request_id AND g.state='succeeded' AND g.input->>'purpose'='reply'));
 END IF;
 RAISE EXCEPTION 'invalid chat action';
END $$;

CREATE OR REPLACE FUNCTION public.artifact_chat_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.artifact_chats%ROWTYPE; t public.artifact_chat_turns%ROWTYPE;
BEGIN
 IF NEW.input->>'conversationId' IS NULL THEN
  IF NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
  RETURN NEW; END IF;
 SELECT * INTO c FROM artifact_chats WHERE conversation_id=(NEW.input->>'conversationId')::uuid AND project_id=NEW.project_id AND round_id=NEW.round_id;
 SELECT * INTO t FROM artifact_chat_turns WHERE conversation_id=c.conversation_id AND request_id=(NEW.input->>'turnId')::uuid AND step_id=NEW.step_id;
 IF c.conversation_id IS NULL OR t.request_id IS NULL OR NEW.input->>'instruction' IS DISTINCT FROM t.body OR NEW.input->>'turnId' IS DISTINCT FROM t.request_id::text THEN RAISE EXCEPTION 'chat generation denied' USING ERRCODE='42501'; END IF;
 IF t.generation_mode='legacy' THEN
  IF NEW.request_id<>t.request_id OR NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'legacy role denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='reply' THEN
  IF NEW.request_id<>t.request_id THEN RAISE EXCEPTION 'reply identity denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='summary' THEN
  IF NOT EXISTS(SELECT 1 FROM artifact_chat_summaries s JOIN artifact_generations parent ON parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=s.turn_id
    WHERE s.turn_id=t.request_id AND s.request_id=NEW.request_id AND parent.state='succeeded' AND parent.input->>'purpose'='reply'
     AND parent.evidence_ids <@ NEW.evidence_ids) THEN RAISE EXCEPTION 'summary parent denied' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' OR (NEW.state='dispatched' AND OLD.state='prepared') THEN
  IF NEW.input->>'purpose'='summary' AND NOT EXISTS(SELECT 1 FROM artifact_generations parent WHERE parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=t.request_id AND parent.quote->>'modelId' <> NEW.quote->>'modelId' AND lower(trim(parent.quote->>'providerModel')) <> lower(trim(NEW.quote->>'providerModel')) AND artifact_evidence_allowed(NEW.project_id,parent.evidence_ids)) THEN RAISE EXCEPTION 'summary source denied' USING ERRCODE='42501'; END IF;
  IF NOT (t.evidence_ids <@ NEW.evidence_ids) OR NOT artifact_evidence_allowed(NEW.project_id,t.evidence_ids) THEN RAISE EXCEPTION 'chat evidence denied' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO NEW.evidence_ids FROM jsonb_array_elements(NEW.evidence_ids||t.evidence_ids) e;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.artifact_save_candidate(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
 p_project_id uuid,p_round_id uuid,p_request_id uuid,p_step_id text,p_candidate_id uuid,p_expected_version integer,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; candidate public.artifact_candidates%ROWTYPE; direct_ids jsonb; effective_ids jsonb; flow jsonb; payload jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM artifact_generations WHERE candidate_id=p_candidate_id AND input->>'purpose'='reply') THEN RAISE EXCEPTION 'reply is not a step result' USING ERRCODE='42501'; END IF;
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
-- A selected Skill validates only its own registrations; unrelated packages are not loaded.
CREATE OR REPLACE FUNCTION public.artifact_module_catalog(p_actor_id uuid,p_module_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.artifact_workflows%ROWTYPE; result jsonb:='[]'; descriptor jsonb;
BEGIN
 IF p_module_id IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM artifact_workflows WHERE enabled AND module_id=p_module_id)>100 THEN RAISE EXCEPTION 'registry capacity'; END IF;
  FOR w IN SELECT * FROM artifact_workflows WHERE enabled AND module_id=p_module_id ORDER BY id LIMIT 100 LOOP
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
END $$;
REVOKE ALL ON FUNCTION public.artifact_module_catalog(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.artifact_module_catalog(uuid,uuid) TO service_role;
-- Preserve the existing service-only retention job and its record categories.
-- Conversation deletion cascades chat/turn/summary transport records. The chat
-- delete guard defers unresolved generations; other expired records still purge.
CREATE OR REPLACE FUNCTION public.purge_deleted_records(p_days_old integer DEFAULT 30)
RETURNS TABLE(table_name text,deleted_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cutoff timestamptz; removed bigint;
BEGIN
 IF p_days_old IS NULL OR p_days_old<1 THEN RAISE EXCEPTION 'invalid retention period'; END IF;
 cutoff:=now()-make_interval(days=>p_days_old);
 DELETE FROM messages WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'messages'::text,removed;
 DELETE FROM conversations WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'conversations'::text,removed;
 DELETE FROM ticket_replies WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'ticket_replies'::text,removed;
 DELETE FROM tickets WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'tickets'::text,removed;
 DELETE FROM prompts WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'prompts'::text,removed;
 DELETE FROM announcements WHERE is_deleted='true' AND deleted_at<cutoff;
 GET DIAGNOSTICS removed=ROW_COUNT; RETURN QUERY SELECT 'announcements'::text,removed;
END $$;
REVOKE ALL ON FUNCTION public.purge_deleted_records(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.purge_deleted_records(integer) TO service_role;
COMMIT;
