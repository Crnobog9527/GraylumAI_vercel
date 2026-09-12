/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- SDK call identities only. Money remains in canonical billing/credit tables.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_slice_calls (
 id uuid PRIMARY KEY,
 execution_id uuid NOT NULL REFERENCES public.agent_slice_executions(request_id),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2),
 quote jsonb NOT NULL CHECK(octet_length(quote::text)<=16384),
 pre_deduct_id uuid NOT NULL,
 dispatch_token uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','dispatched','unknown','responded','settled','refunded')),
 evidence jsonb CHECK(evidence IS NULL OR octet_length(evidence::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(execution_id,sequence)
);
ALTER TABLE public.agent_slice_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_slice_calls FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.agent_slice_call(p_actor_id uuid,p_execution_id uuid,p_call_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE;p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;c agent_slice_calls%ROWTYPE;
 pre uuid;token uuid:=gen_random_uuid();amount integer;spent uuid;ev jsonb;seq integer;account_name text;
BEGIN
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id FOR UPDATE;
 SELECT * INTO p FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id FOR UPDATE;
 IF e.request_id IS NULL OR p.id IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM agent_slice_calls WHERE id=p_call_id;
 IF c.id IS NOT NULL AND c.execution_id<>e.request_id THEN RAISE EXCEPTION 'slice call conflict'; END IF;
 IF p_action='get' THEN
  IF c.id IS NULL THEN RETURN 'null'; END IF;
 ELSIF p_action IN ('evidence','settle','unknown','refund') THEN
  -- Financial completion deliberately does not reopen revoked method/source text.
  IF c.id IS NULL THEN RAISE EXCEPTION 'slice call missing'; END IF;
  IF p_action='evidence' THEN
   ev:=p_payload->'evidence';
   IF c.state IN ('responded','settled') THEN
    IF c.evidence IS DISTINCT FROM ev THEN RAISE EXCEPTION 'slice evidence conflict'; END IF;
   ELSE
    IF c.state NOT IN ('dispatched','unknown') OR c.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RAISE EXCEPTION 'slice call conflict'; END IF;
    IF jsonb_typeof(ev) IS DISTINCT FROM 'object' OR (ev-'providerId'-'finishReason'-'inputTokens'-'outputTokens'-'cacheReadTokens'-'cacheCreationTokens'-'credits'-'costUsd'-'outcome'-'usageEvidence')<>'{}'
     OR (ev->>'inputTokens')::integer NOT BETWEEN 0 AND 2000000 OR (ev->>'outputTokens')::integer NOT BETWEEN 0 AND 2000000
     OR (ev->>'cacheReadTokens')::integer NOT BETWEEN 0 AND 2000000 OR (ev->>'cacheCreationTokens')::integer NOT BETWEEN 0 AND 2000000
     OR ((ev->>'credits')::integer BETWEEN 0 AND (c.quote->>'reservedCredits')::integer) IS DISTINCT FROM true
     OR ((ev->>'costUsd')::numeric>=0) IS DISTINCT FROM true OR (ev->>'outcome' IN ('responded','truncated')) IS DISTINCT FROM true
     OR ev->>'inputTokens' IS NULL OR ev->>'outputTokens' IS NULL OR ev->>'cacheReadTokens' IS NULL OR ev->>'cacheCreationTokens' IS NULL
    THEN RAISE EXCEPTION 'slice evidence invalid'; END IF;
    UPDATE agent_slice_calls SET evidence=ev,state='responded' WHERE id=c.id RETURNING * INTO c;
   END IF;
  ELSIF p_action='settle' AND c.state<>'settled' THEN
   IF c.state<>'responded' THEN RAISE EXCEPTION 'slice outcome unknown'; END IF;
   amount:=(c.evidence->>'credits')::integer;
   PERFORM atomic_settle(p_actor_id,c.pre_deduct_id,amount,
    c.evidence||jsonb_build_object('executionId',e.request_id,'callId',c.id,'pricing',c.quote),jsonb_build_object('callId',c.id));
   IF amount>0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,counts_as_spend,source_type,source_id,idempotency_key,metadata)
     VALUES(p_actor_id,-amount,'deduction','Skill model call','spend','ai_task_spend',true,'ai_task',c.id::text,'agent_slice_call:'||c.id::text,jsonb_build_object('executionId',e.request_id,'callId',c.id)) RETURNING id INTO spent;
    UPDATE billing_history SET transaction_id=spent WHERE user_id=p_actor_id AND operation_type='settle' AND metadata->>'preDeductId'=c.pre_deduct_id::text;
   END IF;
   INSERT INTO token_stats(conversation_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
    VALUES(e.conversation_id,p_actor_id,c.quote->>'providerModel',(c.evidence->>'inputTokens')::integer,(c.evidence->>'outputTokens')::integer,
     (c.evidence->>'cacheReadTokens')::integer,(c.evidence->>'cacheCreationTokens')::integer,0,(c.evidence->>'costUsd')::numeric,amount,jsonb_build_object('executionId',e.request_id,'callId',c.id,'evidence',c.evidence));
   INSERT INTO ai_usage_logs(conversation_id,user_id,request_id,model_id,status,metadata)
    VALUES(e.conversation_id,p_actor_id,c.id::text,c.quote->>'providerModel',CASE WHEN c.evidence->>'outcome'='truncated' THEN 'failed' ELSE 'success' END,jsonb_build_object('executionId',e.request_id,'callId',c.id,'finishReason',c.evidence->'finishReason'));
   UPDATE agent_slice_calls SET state='settled' WHERE id=c.id RETURNING * INTO c;
  ELSIF p_action='unknown' THEN
   IF c.state='dispatched' AND c.dispatch_token=(p_payload->>'token')::uuid THEN UPDATE agent_slice_calls SET state='unknown' WHERE id=c.id RETURNING * INTO c; END IF;
  ELSIF p_action='refund' AND c.state<>'refunded' THEN
   IF c.state<>'prepared' OR c.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RAISE EXCEPTION 'slice refund denied'; END IF;
   PERFORM atomic_refund(p_actor_id,c.pre_deduct_id,'Skill call not dispatched');
   UPDATE agent_slice_calls SET state='refunded' WHERE id=c.id RETURNING * INTO c;
  END IF;
 ELSE
  -- Only new spending needs live source, preference and target authority.
  SELECT * INTO r FROM artifact_rounds WHERE id=e.round_id AND project_id=p.id;
  SELECT root.account INTO account_name FROM artifact_projects root WHERE root.id=p.source_project_id;
  IF r.state IS DISTINCT FROM 'draft' OR r.revision_id<>e.revision_id OR artifact_generation_basis(r.workflow,r.steps,e.step_id) IS DISTINCT FROM e.basis
   OR NOT artifact_evidence_allowed(p.id,e.evidence_ids) OR NOT agent_slice_preferences_valid(p_actor_id,e.preference_refs,account_name)
   OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=e.conversation_id AND user_id=p_actor_id AND is_deleted='false')
   OR NOT EXISTS(SELECT 1 FROM agent_slice_pairs WHERE id=e.pair_id AND enabled)
   OR NOT EXISTS(SELECT 1 FROM system_settings WHERE key='v3_workbench_ai' AND value='true')
  THEN RAISE EXCEPTION 'slice input unavailable'; END IF;
  PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,e.revision_id,NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM modules m JOIN ai_models a ON a.id=m.model_id WHERE m.id=p.module_id AND a.id=e.model_id AND a.model_id=e.provider_model AND a.is_active='true') THEN RAISE EXCEPTION 'slice model unavailable'; END IF;
  IF p_action='prepare' THEN
   seq:=(p_payload->>'sequence')::integer;
   IF c.id IS NOT NULL THEN
    IF c.sequence IS DISTINCT FROM seq OR c.quote IS DISTINCT FROM p_payload->'quote' THEN RAISE EXCEPTION 'slice call conflict'; END IF;
    RETURN jsonb_build_object('callId',c.id,'state',c.state);
   END IF;
   IF (seq BETWEEN 1 AND 2) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM agent_slice_calls WHERE execution_id=e.request_id AND state<>'settled')
    OR seq<>(SELECT count(*)+1 FROM agent_slice_calls WHERE execution_id=e.request_id)
    OR p_payload#>>'{quote,modelId}' IS DISTINCT FROM e.model_id::text OR p_payload#>>'{quote,providerModel}' IS DISTINCT FROM e.provider_model
   THEN RAISE EXCEPTION 'slice call conflict'; END IF;
   amount:=(p_payload#>>'{quote,reservedCredits}')::integer;
   IF (amount BETWEEN 1 AND e.budget_credits) IS DISTINCT FROM true OR amount+(SELECT coalesce(sum((quote->>'reservedCredits')::integer),0) FROM agent_slice_calls WHERE execution_id=e.request_id)>e.budget_credits THEN RAISE EXCEPTION 'slice budget'; END IF;
   SELECT pre_deduct_id INTO pre FROM atomic_pre_deduct(p_actor_id,amount,'Skill model call',p_call_id);
   INSERT INTO agent_slice_calls(id,execution_id,sequence,quote,pre_deduct_id,dispatch_token,state) VALUES(p_call_id,e.request_id,seq,p_payload->'quote',pre,token,'prepared') RETURNING * INTO c;
   RETURN jsonb_build_object('callId',c.id,'state',c.state,'token',token);
  ELSIF p_action='dispatch' THEN
   IF c.id IS NULL OR c.state<>'prepared' OR c.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RETURN '{"dispatch":false}'; END IF;
   UPDATE agent_slice_calls SET state='dispatched' WHERE id=c.id;
   RETURN '{"dispatch":true}';
  ELSE RAISE EXCEPTION 'slice action denied'; END IF;
 END IF;
 RETURN jsonb_build_object('callId',c.id,'state',c.state);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_call(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_call(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
