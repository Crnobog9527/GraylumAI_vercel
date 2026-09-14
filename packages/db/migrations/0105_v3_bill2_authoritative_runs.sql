/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive BILL-2 service boundary. No existing caller is switched to this contract.
BEGIN;
CREATE TABLE IF NOT EXISTS public.bill2_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES profiles(id),
 revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.bill2_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES profiles(id),request_id uuid NOT NULL,
 contract_version text NOT NULL DEFAULT 'bill2.v1' CHECK(contract_version='bill2.v1'),
 scope jsonb NOT NULL,session_ref uuid CHECK(session_ref IS NULL),payload jsonb NOT NULL,
 pre_deduct_id uuid UNIQUE REFERENCES billing_history(id),
 reserved integer NOT NULL CHECK(reserved>0),budget_usd numeric NOT NULL CHECK(budget_usd>0),
 credits_per_usd numeric NOT NULL CHECK(credits_per_usd>0),multiplier numeric NOT NULL CHECK(multiplier>0),
 max_calls integer NOT NULL CHECK(max_calls BETWEEN 1 AND 32),deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','unknown','cost_pending','settled','refunded')),
 closed boolean NOT NULL DEFAULT false,cancel_requested boolean NOT NULL DEFAULT false,
 outcome text CHECK(outcome IN ('delivered','confirmed_failure','cancelled','unknown')),
 result jsonb,conflict boolean NOT NULL DEFAULT false,charged integer,actual_restore integer,
 provider_cost_usd numeric,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,request_id),CHECK(octet_length(payload::text)<=262144)
);
CREATE TABLE IF NOT EXISTS public.bill2_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES bill2_runs(id),sequence integer NOT NULL,
 payload jsonb NOT NULL,provider text NOT NULL,account_namespace text NOT NULL,model text NOT NULL,
 upper_usd numeric NOT NULL CHECK(upper_usd>0),token uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','responded','unknown','cancelled')),
 dispatched_at timestamptz,provider_id text,selected_cost_usd numeric,
 recovery_attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,sequence),CHECK(octet_length(payload::text)<=65536)
);
CREATE INDEX IF NOT EXISTS bill2_calls_run ON bill2_calls(run_id,id);
CREATE TABLE IF NOT EXISTS public.bill2_provider_ids (
 provider text NOT NULL,account_namespace text NOT NULL,provider_id text NOT NULL,call_id uuid NOT NULL REFERENCES bill2_calls(id),
 PRIMARY KEY(provider,account_namespace,provider_id)
);
CREATE TABLE IF NOT EXISTS public.bill2_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),call_id uuid NOT NULL REFERENCES bill2_calls(id),
 payload jsonb NOT NULL,payload_hash text NOT NULL,conflict boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(call_id,payload_hash),CHECK(octet_length(payload::text)<=524288)
);
CREATE INDEX IF NOT EXISTS bill2_receipts_call ON bill2_receipts(call_id,id);
ALTER TABLE token_stats ADD COLUMN IF NOT EXISTS bill2_run_id uuid REFERENCES bill2_runs(id);
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS bill2_run_id uuid REFERENCES bill2_runs(id);
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS bill2_run_id uuid REFERENCES bill2_runs(id);
-- Release-then-spend decomposition can temporarily exceed INT although the real balance never does.
ALTER TABLE credit_transactions ALTER COLUMN balance_before TYPE bigint;
ALTER TABLE credit_transactions ALTER COLUMN balance_after TYPE bigint;
CREATE UNIQUE INDEX IF NOT EXISTS token_stats_bill2_run ON token_stats(bill2_run_id) WHERE bill2_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_logs_bill2_run ON ai_usage_logs(bill2_run_id) WHERE bill2_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_bill2_phase ON credit_transactions(bill2_run_id,reason_code) WHERE bill2_run_id IS NOT NULL;
ALTER TABLE token_stats DROP CONSTRAINT IF EXISTS token_stats_execution_scope;
ALTER TABLE token_stats ADD CONSTRAINT token_stats_execution_scope CHECK
 (num_nonnulls(conversation_id,artifact_generation_id,bill2_run_id)=1);

CREATE OR REPLACE FUNCTION public.bill2_decimal(v jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v#>>'{}') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' THEN
  RAISE EXCEPTION 'BILL2_INVALID_DECIMAL'; END IF;
 RETURN (v#>>'{}')::numeric;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_actor(a uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF a IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=a AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN s->>'kind'='positioning_draft' THEN
   NOT(s ? 'projectId' OR s ? 'workItemId') AND EXISTS(SELECT 1 FROM bill2_drafts WHERE id=(s->>'draftId')::uuid AND actor_id=a AND NOT revoked)
 WHEN s->>'kind'='work_item' THEN NOT(s ? 'draftId') AND EXISTS(
   SELECT 1 FROM artifact_projects w JOIN artifact_projects p ON p.id=w.source_project_id
   WHERE w.id=(s->>'workItemId')::uuid AND p.id=(s->>'projectId')::uuid
   AND w.actor_id=a AND p.actor_id=a AND w.work_kind='script' AND p.work_kind='legacy'
   AND (p.account IS NULL OR EXISTS(SELECT 1 FROM artifact_work_references ref WHERE ref.project_id=w.id AND artifact_reference_available(ref.evidence_id))))
 ELSE false END;
$$;
-- Lock scope/model/revision before admission; no money-path calls this helper after taking a profile lock.
CREATE OR REPLACE FUNCTION public.bill2_execution_allowed(a uuid,p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb;m uuid;k uuid;rev uuid; policy jsonb; entry jsonb;
BEGIN
 PERFORM bill2_actor(a);
 IF p->'scope'->>'kind'='positioning_draft' THEN
  PERFORM id FROM bill2_drafts WHERE id=(p->'scope'->>'draftId')::uuid AND actor_id=a AND NOT revoked FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 ELSE
  -- Match artifact_create_work / reference save order: config, source, account, target.
  PERFORM cfg.id FROM artifact_reference_configs cfg WHERE cfg.id IN (SELECT config_id FROM artifact_work_references WHERE project_id=(p->'scope'->>'workItemId')::uuid) ORDER BY cfg.id FOR SHARE;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'projectId')::uuid FOR SHARE;
  PERFORM ac.actor_id FROM artifact_accounts ac JOIN artifact_projects src ON src.id=(p->'scope'->>'projectId')::uuid
   WHERE ac.actor_id=src.actor_id AND ac.module_id=src.module_id AND ac.skill_id=src.skill_id AND ac.account=src.account FOR KEY SHARE OF ac;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid FOR SHARE;
 END IF;
 IF NOT coalesce(bill2_scope_allowed(a,p->'scope'),false) THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 policy:=p->'callPolicy';
 IF jsonb_typeof(policy) IS DISTINCT FROM 'array' OR jsonb_array_length(policy) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_REQUIRED';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(policy) ORDER BY value->>'modelId' LOOP
  PERFORM id FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND provider=entry->>'provider' AND is_active='true' FOR SHARE;
  IF NOT FOUND OR entry->>'protocol' IS DISTINCT FROM 'fixture-cost-v1' OR coalesce(length(entry->>'account'),0)=0
  OR coalesce((entry->>'inputLimit')::int,0) NOT BETWEEN 1 AND 1000000 OR coalesce((entry->>'outputLimit')::int,0) NOT BETWEEN 1 AND 1000000
  OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'automaticRetry' IS DISTINCT FROM 'false'::jsonb OR entry->'hiddenTools' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(entry->'lookupSupported') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 rev:=(p->>'revisionId')::uuid;
 IF rev IS NOT NULL THEN
  m:=(p->>'moduleId')::uuid;k:=(p->>'skillId')::uuid;
  IF p->'scope'->>'kind'='work_item' THEN SELECT module_id,skill_id INTO m,k FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid;END IF;
  PERFORM id FROM modules WHERE id=m ORDER BY id FOR SHARE;
  PERFORM id FROM skills WHERE id=k FOR SHARE;
  PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
  PERFORM read_skill_package(a,m,k,rev,NULL,'');
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_create_draft(p_actor_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x uuid;BEGIN PERFORM bill2_actor(p_actor_id);INSERT INTO bill2_drafts(actor_id) VALUES(p_actor_id) RETURNING id INTO x;RETURN x;END $$;
CREATE OR REPLACE FUNCTION public.bill2_revoke_draft(p_actor_id uuid,p_draft_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN UPDATE bill2_drafts SET revoked=true WHERE id=p_draft_id AND actor_id=p_actor_id;IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;END $$;

-- Only the projection is exposed. Private input/result/evidence never enters this response.
CREATE OR REPLACE FUNCTION public.bill2_public(r bill2_runs) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'scope',r.scope,'state',r.state,'closed',r.closed,'cancelRequested',r.cancel_requested,
 'outcome',r.outcome,'reservedCredits',r.reserved,'chargedCredits',r.charged,'actualRestoredCredits',r.actual_restore,
 'preDeductId',r.pre_deduct_id,'providerCostUsd',r.provider_cost_usd::text,'conflict',r.conflict,'version',r.version,'contractVersion',r.contract_version);
$$;
CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;BEGIN PERFORM bill2_actor(p_actor_id);SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 RETURN bill2_public(r)||jsonb_build_object('calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $$;
CREATE OR REPLACE FUNCTION public.bill2_prepare(p_actor_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs; q record; b numeric; rate numeric; m numeric; reservation integer; new_id uuid:=gen_random_uuid(); fx record;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 -- Serialize missing-row admission before any profile/grant lock; no legacy lock takes this advisory lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 SELECT * INTO r FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
 IF r.id IS NOT NULL THEN IF r.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_REQUEST_CONFLICT';END IF;RETURN bill2_public(r);END IF;
 PERFORM bill2_execution_allowed(p_actor_id,p_payload);
 IF p_payload->>'contractVersion' IS DISTINCT FROM 'bill2.v1' OR p_payload->>'sessionRef' IS NOT NULL
 OR p_payload->>'operation' IS NULL OR p_payload->>'operation' NOT IN ('question','research','organize','plan','work')
 OR (p_payload->'scope'->>'kind'='positioning_draft' AND p_payload->>'operation'='work')
 OR p_payload->>'mode' IS DISTINCT FROM 'isolated' OR NOT(p_payload ? 'input')
 OR coalesce(p_payload->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR coalesce(length(p_payload->'rules'->>'version'),0)=0
 OR coalesce(length(p_payload->'rules'->>'quoteVersion'),0)=0 THEN RAISE EXCEPTION 'BILL2_INVALID_CONTRACT';END IF;
 IF NOT EXISTS(SELECT 1 FROM ai_models WHERE id=(p_payload->>'modelId')::uuid AND is_active='true') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 IF p_payload->>'revisionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_revisions sr JOIN skills s ON s.id=sr.skill_id WHERE sr.id=(p_payload->>'revisionId')::uuid AND s.status='published') THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
 b:=bill2_decimal(p_payload->'limits'->'costUsd');rate:=bill2_decimal(p_payload->'rules'->'creditsPerUsd');m:=bill2_decimal(p_payload->'rules'->'multiplier');
 reservation:=(p_payload->'limits'->>'credits')::integer;
 IF b<=0 OR b>100000 OR rate<=0 OR m<=0 OR reservation IS NULL OR reservation<=0 OR ceil(b*rate*m)>reservation
 OR reservation>(p_payload->'limits'->>'maxPreDeduct')::integer OR (p_payload->'limits'->>'maxPreDeduct') IS NULL
 OR coalesce((p_payload->'limits'->>'maxCalls')::integer,0) NOT BETWEEN 1 AND 32
 OR (p_payload->'limits'->>'deadline') IS NULL OR (p_payload->'limits'->>'deadline')::timestamptz<=clock_timestamp()
 OR (p_payload->'limits'->>'deadline')::timestamptz>clock_timestamp()+interval '24 hours'
 OR jsonb_typeof(p_payload->'rules'->'fx') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_INVALID_BUDGET';END IF;
 FOR fx IN SELECT * FROM jsonb_each(p_payload->'rules'->'fx') LOOP
  IF fx.key !~ '^[A-Z]{3}$' OR coalesce(length(fx.value->>'version'),0)=0 OR bill2_decimal(fx.value->'usdPerUnit')<=0 THEN RAISE EXCEPTION 'BILL2_INVALID_FX';END IF;
 END LOOP;
 -- Lock directly for update: admission must observe a suspension that won the profile lock, without a share-lock upgrade race.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline)
 VALUES(new_id,p_actor_id,p_request_id,p_payload->'scope',p_payload,reservation,b,rate,m,(p_payload->'limits'->>'maxCalls')::integer,(p_payload->'limits'->>'deadline')::timestamptz);
 -- Internal UUID is independent of public/legacy request IDs. Never adopt an old pre-deduction.
 SELECT * INTO q FROM atomic_pre_deduct(p_actor_id,reservation,'BILL2 reservation',new_id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_runs SET pre_deduct_id=q.pre_deduct_id WHERE id=new_id RETURNING * INTO r;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(p_actor_id,-reservation,'adjustment','Run reservation','adjustment','bill2_reserve','ai_task',new_id::text,'bill2:'||new_id||':reserve',q.balance_before,q.balance_after,new_id,jsonb_build_object('contractVersion','bill2.v1','preDeductId',q.pre_deduct_id));
 RETURN bill2_public(r);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid,p_run_id uuid,p_sequence integer,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM bill2_execution_allowed(p_actor_id,r.payload);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=r.id AND sequence=p_sequence;
 IF c.id IS NOT NULL THEN IF c.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);END IF;
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0) INTO n,used FROM bill2_calls WHERE run_id=r.id;
 upper_cost:=bill2_decimal(p_payload->'upperUsd');
 IF p_sequence IS DISTINCT FROM n+1 OR n>=r.max_calls OR upper_cost<=0 OR used+upper_cost>r.budget_usd OR ceil((used+upper_cost)*r.credits_per_usd*r.multiplier)>r.reserved
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'callPolicy') policy WHERE policy->>'provider'=p_payload->>'provider' AND policy->>'account'=p_payload->>'account' AND policy->>'model'=p_payload->>'model' AND policy->>'protocol'=p_payload->>'protocol' AND (p_payload->>'inputLimit')::int<=(policy->>'inputLimit')::int AND (p_payload->>'outputLimit')::int<=(policy->>'outputLimit')::int AND upper_cost<=bill2_decimal(policy->'upperUsd') AND policy->'lookupSupported'=p_payload->'lookupSupported')
 OR coalesce(length(p_payload->>'provider'),0)=0 OR coalesce(length(p_payload->>'account'),0)=0 OR coalesce(length(p_payload->>'model'),0)=0
 OR coalesce(p_payload->>'requestHash','') !~ '^[a-f0-9]{64}$' OR p_payload->>'protocol' IS DISTINCT FROM 'fixture-cost-v1'
 OR (p_payload->>'inputLimit') IS NULL OR (p_payload->>'inputLimit')::integer<=0 OR (p_payload->>'outputLimit') IS NULL OR (p_payload->>'outputLimit')::integer<=0
 OR p_payload->>'automaticRetry' IS DISTINCT FROM 'false' OR p_payload->>'hiddenTools' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd) VALUES(r.id,p_sequence,p_payload,p_payload->>'provider',p_payload->>'account',p_payload->>'model',upper_cost) RETURNING * INTO c;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_dispatch(p_actor_id uuid,p_run_id uuid,p_call_id uuid,p_token uuid,p_rotate boolean DEFAULT false,p_payload jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM bill2_execution_allowed(p_actor_id,r.payload);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_DENIED';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline OR c.state<>'prepared' OR (NOT p_rotate AND c.token IS DISTINCT FROM p_token) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 -- Final permission check serializes a concurrent account suspension before any HTTP grant.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF p_rotate THEN IF p_payload IS DISTINCT FROM c.payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF; UPDATE bill2_calls SET token=gen_random_uuid() WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('dispatch',false,'dispatchToken',c.token);END IF;
 UPDATE bill2_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=c.id;
 UPDATE bill2_runs SET state='dispatched',version=version+1 WHERE id=r.id;
 RETURN jsonb_build_object('dispatch',true);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_record(p_actor_id uuid,p_run_id uuid,p_call_id uuid,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;other_id uuid;h text;raw_cost numeric;cost numeric;bad boolean:=false;prior jsonb;currency text;piece jsonb;parts numeric:=0;detail_total numeric;total_observation jsonb;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_NOT_DISPATCHED';END IF;
 IF p_evidence->>'provider' IS DISTINCT FROM c.provider OR p_evidence->>'account' IS DISTINCT FROM c.account_namespace OR p_evidence->>'protocol' IS DISTINCT FROM c.payload->>'protocol'
 OR coalesce(p_evidence->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_evidence->'final') IS DISTINCT FROM 'boolean' OR coalesce(length(p_evidence->>'source'),0)=0 OR p_evidence->>'observedAt' IS NULL
 OR p_evidence->>'coverage' IS NULL OR p_evidence->>'coverage' NOT IN ('request_total','included_detail') THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
 h:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_public(r);END IF;
 IF p_evidence->>'providerId' IS NOT NULL THEN
  IF length(p_evidence->>'providerId') NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'BILL2_INVALID_PROVIDER_ID';END IF;
  INSERT INTO bill2_provider_ids VALUES(c.provider,c.account_namespace,p_evidence->>'providerId',c.id) ON CONFLICT DO NOTHING;
  SELECT call_id INTO other_id FROM bill2_provider_ids WHERE provider=c.provider AND account_namespace=c.account_namespace AND provider_id=p_evidence->>'providerId';
  bad:=other_id<>c.id OR (c.provider_id IS NOT NULL AND c.provider_id IS DISTINCT FROM p_evidence->>'providerId');
  IF NOT bad THEN UPDATE bill2_calls SET provider_id=p_evidence->>'providerId' WHERE id=c.id;END IF;
 END IF;
 -- Transport observations preserve diagnostics/IDs but never assert cost, finality or delivery.
 IF p_evidence->>'evidenceKind'='transport_observation' THEN
  IF p_evidence->>'cost' IS NOT NULL OR p_evidence->>'final' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
  bad:=bad OR (p_evidence->>'providerId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS DISTINCT FROM p_evidence->>'providerId');
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict) VALUES(c.id,p_evidence,h,bad);
  UPDATE bill2_runs SET conflict=conflict OR bad,version=version+1,
   state=CASE WHEN state IN ('settled','refunded') OR c.selected_cost_usd IS NOT NULL THEN state
    WHEN coalesce(c.provider_id,p_evidence->>'providerId') IS NULL THEN 'unknown' ELSE 'cost_pending' END
   WHERE id=r.id RETURNING * INTO r;
  RETURN bill2_public(r);
 END IF;
 bad:=bad OR p_evidence->>'model' IS DISTINCT FROM c.model OR p_evidence->>'rejectedReason' IS NOT NULL OR (p_evidence->>'expectedProviderId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS DISTINCT FROM p_evidence->>'providerId');
 IF p_evidence->>'cost' IS NOT NULL THEN raw_cost:=bill2_decimal(p_evidence->'cost');END IF;
 currency:=p_evidence->>'currency';
 IF raw_cost IS NOT NULL THEN
  IF currency='USD' THEN cost:=raw_cost;
  ELSIF r.payload->'rules'->'fx' ? currency THEN cost:=raw_cost*bill2_decimal(r.payload->'rules'->'fx'->currency->'usdPerUnit');END IF;
 END IF;
 IF coalesce(jsonb_typeof(p_evidence->'includedDetails'),'array')<>'array' THEN RAISE EXCEPTION 'BILL2_INVALID_COVERAGE';END IF;
 FOR piece IN SELECT * FROM jsonb_array_elements(coalesce(p_evidence->'includedDetails','[]')) LOOP
  parts:=parts+bill2_decimal(piece->'cost');IF piece->>'currency' IS DISTINCT FROM currency THEN bad:=true;END IF;
 END LOOP;
 IF raw_cost IS NOT NULL AND parts>raw_cost THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='request_total' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR prior->>'model' IS DISTINCT FROM p_evidence->>'model' OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
  IF cost IS NOT NULL AND cost>c.upper_usd THEN bad:=true;END IF;
 END IF;
 -- Independent detail observations are scoped to the parent generation and a stable detailId.
 -- Never add them to an inline detail array; both describe portions of the same total.
 IF p_evidence->>'coverage'='included_detail' AND coalesce(length(p_evidence->>'detailId'),0) NOT BETWEEN 1 AND 128 THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='included_detail' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='included_detail' AND payload->>'detailId'=p_evidence->>'detailId' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
 END IF;
 FOR total_observation IN
  SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL
  UNION ALL SELECT p_evidence WHERE p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND raw_cost IS NOT NULL
 LOOP
  WITH observations AS (
   SELECT payload FROM bill2_receipts WHERE call_id=c.id
   UNION ALL SELECT p_evidence),
  details AS (SELECT payload->>'detailId' id,max(bill2_decimal(payload->'cost')) amount
   FROM observations WHERE payload->>'coverage'='included_detail' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL AND payload->>'detailId' IS NOT NULL
   GROUP BY payload->>'detailId')
  SELECT coalesce(sum(amount),0) INTO detail_total FROM details;
  IF detail_total>bill2_decimal(total_observation->'cost') OR EXISTS(
   SELECT 1 FROM (SELECT payload FROM bill2_receipts WHERE call_id=c.id UNION ALL SELECT p_evidence) obs
   WHERE payload->>'coverage'='included_detail' AND payload->>'cost' IS NOT NULL AND payload->>'currency' IS DISTINCT FROM total_observation->>'currency') THEN bad:=true;END IF;
 END LOOP;
 INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict) VALUES(c.id,p_evidence,h,bad);
 IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  IF p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND cost IS NOT NULL AND p_evidence->>'providerId' IS NOT NULL THEN
   UPDATE bill2_calls SET selected_cost_usd=cost,state='responded' WHERE id=c.id;
  ELSE UPDATE bill2_calls SET state=CASE WHEN selected_cost_usd IS NULL THEN 'unknown' ELSE state END WHERE id=c.id;END IF;
  IF r.state IN ('settled','refunded') THEN
   UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0 THEN coalesce(sum(selected_cost_usd),0) ELSE NULL END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE UPDATE bill2_runs SET state=CASE WHEN p_evidence->>'providerId' IS NULL THEN 'unknown' ELSE 'cost_pending' END,version=version+1 WHERE id=r.id RETURNING * INTO r;END IF;
 END IF;
 RETURN bill2_public(r);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_close(p_actor_id uuid,p_run_id uuid,p_outcome text,p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.state IN ('settled','refunded') THEN RETURN bill2_public(r);END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('delivered','confirmed_failure','cancelled','unknown') THEN RAISE EXCEPTION 'BILL2_INVALID_OUTCOME';END IF;
 IF r.closed AND r.outcome<>'unknown' THEN IF r.outcome IS DISTINCT FROM p_outcome OR r.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'BILL2_CLOSE_CONFLICT';END IF;RETURN bill2_public(r);END IF;
 IF p_outcome IN ('delivered','confirmed_failure') AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR coalesce(length(p_result->>'evidenceRef'),0)=0 OR coalesce(length(p_result->>'evidenceHash'),0)<>64
 OR p_result->>'kind' IS DISTINCT FROM CASE WHEN p_outcome='delivered' THEN 'usable_result' ELSE 'confirmed_delivery_failure' END) THEN RAISE EXCEPTION 'BILL2_OUTCOME_EVIDENCE_REQUIRED';END IF;
 IF octet_length(coalesce(p_result,'{}')::text)>262144 THEN RAISE EXCEPTION 'BILL2_RESULT_TOO_LARGE';END IF;
 UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid() WHERE run_id=r.id AND state='prepared';
 UPDATE bill2_runs SET closed=true,outcome=p_outcome,result=p_result,cancel_requested=cancel_requested OR p_outcome='cancelled',version=version+1,
 state=CASE WHEN p_outcome='unknown' THEN 'unknown' ELSE state END WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_public(r);
END $$;
CREATE OR REPLACE FUNCTION public.bill2_cancel(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.state NOT IN ('settled','refunded') THEN
 UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid() WHERE run_id=r.id AND state='prepared';
 UPDATE bill2_runs SET cancel_requested=true,closed=true,outcome=CASE WHEN outcome='unknown' THEN 'cancelled' ELSE coalesce(outcome,'cancelled') END,version=version+1 WHERE id=r.id RETURNING * INTO r;
 END IF;RETURN bill2_public(r);
END $$;

-- Preserve the current source-allocation implementations and their old signatures.
-- Private originals are not executable by service_role. No caller-controlled bypass flag.
DO $$ BEGIN
 IF to_regprocedure('public.bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)') IS NULL THEN
 ALTER FUNCTION public.atomic_settle(uuid,uuid,integer,jsonb,jsonb) RENAME TO bill2_legacy_settle;
 ALTER FUNCTION public.atomic_refund(uuid,uuid,text) RENAME TO bill2_legacy_refund;
 ALTER FUNCTION public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text) RENAME TO bill2_legacy_abort_settle;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.atomic_settle(p_user_id uuid,p_pre_deduct_id uuid,p_actual_credits integer,p_usage jsonb DEFAULT '{}',p_response jsonb DEFAULT NULL)
RETURNS TABLE(actual_credits integer,difference integer,balance_after integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_settle(p_user_id,p_pre_deduct_id,p_actual_credits,p_usage,p_response);END $$;
CREATE OR REPLACE FUNCTION public.atomic_refund(p_user_id uuid,p_pre_deduct_id uuid,p_reason text DEFAULT 'AI 调用失败退费')
RETURNS TABLE(refund_amount integer,balance_after integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_refund(p_user_id,p_pre_deduct_id,p_reason);END $$;
CREATE OR REPLACE FUNCTION public.atomic_abort_settle(p_user_id uuid,p_pre_deduct_id uuid,p_consumed_credits integer,p_consumed_tokens jsonb,p_model_id text,p_reason text DEFAULT '用户中断')
RETURNS TABLE(consumed_credits integer,refunded_credits integer,balance_after integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_abort_settle(p_user_id,p_pre_deduct_id,p_consumed_credits,p_consumed_tokens,p_model_id,p_reason);END $$;

DO $$ BEGIN IF to_regprocedure('public.bill2_legacy_finalize_success(UUID,UUID,TEXT,TEXT,TEXT,numeric,INTEGER,UUID,JSONB,JSONB,JSONB,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT)') IS NULL THEN ALTER FUNCTION public.atomic_finalize_ai_success(UUID,UUID,TEXT,TEXT,TEXT,numeric,INTEGER,UUID,JSONB,JSONB,JSONB,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT) RENAME TO bill2_legacy_finalize_success;END IF;END $$;
CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_success(
  p_user_id UUID,
  p_conversation_id UUID,
  p_user_message TEXT,
  p_assistant_message TEXT,
  p_model_used TEXT,
  p_total_cost_usd NUMERIC(12, 6),
  p_total_credits INTEGER,
  p_pre_deduct_id UUID DEFAULT NULL,
  p_usage JSONB DEFAULT '{}'::JSONB,
  p_token_metadata JSONB DEFAULT '{}'::JSONB,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_search_count INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_message_id UUID,
  assistant_message_id UUID,
  transaction_id UUID,
  settle_id UUID,
  balance_after INTEGER,
  refunded_credits INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_success(p_user_id,p_conversation_id,p_user_message,p_assistant_message,p_model_used,p_total_cost_usd,p_total_credits,p_pre_deduct_id,p_usage,p_token_metadata,p_usage_metadata,p_request_id,p_input_length,p_latency_ms,p_search_count,p_ip_address,p_user_agent);
END $$;
DO $$ BEGIN IF to_regprocedure('public.bill2_legacy_finalize_failure(UUID,TEXT,TEXT,UUID,UUID,TEXT,INTEGER,INTEGER,TEXT,TEXT,JSONB)') IS NULL THEN ALTER FUNCTION public.atomic_finalize_ai_failure(UUID,TEXT,TEXT,UUID,UUID,TEXT,INTEGER,INTEGER,TEXT,TEXT,JSONB) RENAME TO bill2_legacy_finalize_failure;END IF;END $$;
CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_failure(
  p_user_id UUID,
  p_model_used TEXT,
  p_reason TEXT,
  p_pre_deduct_id UUID DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  refund_amount INTEGER,
  balance_after INTEGER,
  transaction_id UUID,
  refund_id UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_failure(p_user_id,p_model_used,p_reason,p_pre_deduct_id,p_conversation_id,p_request_id,p_input_length,p_latency_ms,p_ip_address,p_user_agent,p_usage_metadata);
END $$;
DO $$ BEGIN IF to_regprocedure('public.bill2_legacy_finalize_abort(UUID,UUID,TEXT,TEXT,TEXT,numeric,INTEGER,UUID,JSONB,JSONB,JSONB,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT)') IS NULL THEN ALTER FUNCTION public.atomic_finalize_ai_abort(UUID,UUID,TEXT,TEXT,TEXT,numeric,INTEGER,UUID,JSONB,JSONB,JSONB,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT) RENAME TO bill2_legacy_finalize_abort;END IF;END $$;
CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_abort(
  p_user_id UUID,
  p_conversation_id UUID,
  p_user_message TEXT,
  p_partial_assistant_message TEXT,
  p_model_used TEXT,
  p_total_cost_usd NUMERIC(12, 6),
  p_consumed_credits INTEGER,
  p_pre_deduct_id UUID,
  p_usage JSONB DEFAULT '{}'::JSONB,
  p_token_metadata JSONB DEFAULT '{}'::JSONB,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_search_count INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_message_id UUID,
  assistant_message_id UUID,
  transaction_id UUID,
  abort_id UUID,
  balance_after INTEGER,
  refunded_credits INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_abort(p_user_id,p_conversation_id,p_user_message,p_partial_assistant_message,p_model_used,p_total_cost_usd,p_consumed_credits,p_pre_deduct_id,p_usage,p_token_metadata,p_usage_metadata,p_request_id,p_input_length,p_latency_ms,p_search_count,p_ip_address,p_user_agent);
END $$;

-- Keep unknown usage unknown; preserve the old not-null contract for legacy rows.
ALTER TABLE token_stats ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE token_stats ALTER COLUMN output_tokens DROP NOT NULL;
ALTER TABLE token_stats ALTER COLUMN cached_tokens DROP NOT NULL;
ALTER TABLE token_stats ALTER COLUMN cache_creation_tokens DROP NOT NULL;
ALTER TABLE token_stats ALTER COLUMN web_search_count DROP NOT NULL;
ALTER TABLE token_stats ALTER COLUMN total_cost_usd TYPE numeric;
ALTER TABLE token_stats DROP CONSTRAINT IF EXISTS token_stats_legacy_usage_required;
ALTER TABLE token_stats ADD CONSTRAINT token_stats_legacy_usage_required CHECK(bill2_run_id IS NOT NULL OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND cache_creation_tokens IS NOT NULL AND web_search_count IS NOT NULL));
-- Usage is projection only; unreported or invalid counters remain NULL, never inferred from cost.
CREATE OR REPLACE FUNCTION public.bill2_usage_total(rid uuid,field text) RETURNS integer LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH observations AS (
 SELECT (SELECT payload->'usage'->>field FROM bill2_receipts e WHERE e.call_id=c.id AND NOT e.conflict AND e.payload->>'coverage'='request_total' AND e.payload->>'final'='true' AND e.payload->>'cost' IS NOT NULL ORDER BY e.created_at DESC,e.id DESC LIMIT 1) value
 FROM bill2_calls c WHERE c.run_id=rid AND c.dispatched_at IS NOT NULL),
 counters AS (SELECT CASE WHEN value ~ '^(0|[1-9][0-9]{0,9})$' THEN value::bigint ELSE NULL END v FROM observations)
 SELECT CASE WHEN count(*)>0 AND count(v)=count(*) AND sum(v)<=2147483647 THEN sum(v)::integer ELSE NULL END FROM counters;
$$;
CREATE OR REPLACE FUNCTION public.bill2_finalize(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;n integer;pending integer;cost numeric;credits integer:=0;before_balance integer;after_balance integer;restored integer;release_amount integer;spent uuid;meta jsonb;q record;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.state IN ('settled','refunded') THEN RETURN bill2_public(r);END IF;
 IF NOT r.closed THEN RAISE EXCEPTION 'BILL2_CALL_SET_OPEN';END IF;
 -- All receipt/call writers take the run lock first. Read/lock order is deterministic.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM e.id FROM bill2_receipts e JOIN bill2_calls c ON c.id=e.call_id WHERE c.run_id=r.id ORDER BY e.id FOR UPDATE OF e;
 SELECT count(*) FILTER(WHERE dispatched_at IS NOT NULL),count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL),coalesce(sum(selected_cost_usd),0)
 INTO n,pending,cost FROM bill2_calls WHERE run_id=r.id;
 IF n>0 AND r.outcome IS DISTINCT FROM 'confirmed_failure' THEN
  IF r.conflict OR pending>0 OR r.outcome='unknown' THEN RETURN bill2_public(r);END IF;
  IF r.outcome IS NULL OR r.outcome NOT IN ('delivered','cancelled') THEN RAISE EXCEPTION 'BILL2_OUTCOME_REQUIRED';END IF;
  IF cost>r.budget_usd OR ceil(cost*r.credits_per_usd*r.multiplier)>r.reserved THEN
   UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;RETURN bill2_public(r);END IF;
  credits:=ceil(cost*r.credits_per_usd*r.multiplier)::integer;
 END IF;
 SELECT p.credits INTO before_balance FROM profiles p WHERE p.id=p_actor_id FOR UPDATE;
 meta:=jsonb_build_object('contractVersion',r.contract_version,'runId',r.id,'preDeductId',r.pre_deduct_id,'outcome',r.outcome,'providerCostUsd',CASE WHEN pending=0 THEN cost::text ELSE NULL END);
 IF n=0 OR r.outcome='confirmed_failure' THEN
  SELECT * INTO q FROM bill2_legacy_refund(p_actor_id,r.pre_deduct_id,'BILL2 confirmed failure or no dispatch');
  restored:=q.refund_amount;after_balance:=q.balance_after;release_amount:=restored;
 ELSE
  SELECT * INTO q FROM bill2_legacy_settle(p_actor_id,r.pre_deduct_id,credits,meta,NULL);
  restored:=q.difference;after_balance:=q.balance_after;release_amount:=restored+credits;
 END IF;
 SELECT meta || b.metadata INTO meta FROM billing_history b WHERE b.metadata->>'preDeductId'=r.pre_deduct_id::text AND b.operation_type IN ('settle','refund','abort_settle');
 IF after_balance-before_balance<>restored OR restored<0 OR release_amount>r.reserved THEN RAISE EXCEPTION 'BILL2_SOURCE_CONSERVATION';END IF;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(p_actor_id,release_amount,'adjustment','Run reservation release','adjustment','bill2_release','ai_task',r.id::text,'bill2:'||r.id||':release',before_balance,before_balance::bigint+release_amount,r.id,meta||jsonb_build_object('nominalReserved',r.reserved,'actualRestore',restored,'intercepted',r.reserved-release_amount));
 IF n>0 AND r.outcome<>'confirmed_failure' THEN
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
  VALUES(p_actor_id,-credits,'consumption','AI run consumption','spend','bill2_spend','ai_task',r.id::text,'bill2:'||r.id||':spend',before_balance::bigint+release_amount,after_balance,r.id,meta) RETURNING id INTO spent;
  UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=r.pre_deduct_id::text;
  INSERT INTO token_stats(bill2_run_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
  VALUES(r.id,p_actor_id,'bill2.aggregate',bill2_usage_total(r.id,'inputTokens'),bill2_usage_total(r.id,'outputTokens'),bill2_usage_total(r.id,'cachedTokens'),bill2_usage_total(r.id,'cacheCreationTokens'),bill2_usage_total(r.id,'webSearchCount'),cost,credits,meta||jsonb_build_object('usageInPrivateReceipts',true));
  INSERT INTO ai_usage_logs(bill2_run_id,user_id,request_id,model_id,status,metadata)
  VALUES(r.id,p_actor_id,r.request_id::text,'bill2.aggregate','success',meta);
 END IF;
 UPDATE bill2_runs SET state=CASE WHEN n=0 OR outcome='confirmed_failure' THEN 'refunded' ELSE 'settled' END,
 charged=credits,actual_restore=restored,provider_cost_usd=CASE WHEN pending=0 THEN cost ELSE NULL END,version=version+1 WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_public(r);
END $$;

-- Bounded trusted lookup admission. No dispatch, guessing or account enumeration.
CREATE OR REPLACE FUNCTION public.bill2_recovery_claim(p_actor_id uuid,p_run_id uuid,p_call_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL OR c.provider_id IS NULL OR c.selected_cost_usd IS NOT NULL OR c.recovery_attempts>=3
 OR clock_timestamp()>r.deadline+interval '24 hours' OR c.payload->>'lookupSupported' IS DISTINCT FROM 'true' OR r.conflict THEN RETURN NULL;END IF;
 UPDATE bill2_calls SET recovery_attempts=recovery_attempts+1 WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'providerId',c.provider_id,'provider',c.provider,'account',c.account_namespace,'model',c.model,'protocol',c.payload->>'protocol');
END $$;
CREATE OR REPLACE FUNCTION public.bill2_pending_calls(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 RETURN (SELECT coalesce(jsonb_agg(id ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=p_run_id AND dispatched_at IS NOT NULL AND selected_cost_usd IS NULL);
END $$;
CREATE OR REPLACE FUNCTION public.bill2_private_input(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;BEGIN PERFORM bill2_actor(p_actor_id);SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM bill2_execution_allowed(p_actor_id,r.payload);
 RETURN jsonb_build_object('input',r.payload->'input','result',r.result);END $$;

CREATE OR REPLACE FUNCTION public.bill2_evidence_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';END $$;
DROP TRIGGER IF EXISTS bill2_evidence_immutable ON bill2_receipts;
CREATE TRIGGER bill2_evidence_immutable BEFORE UPDATE OR DELETE ON bill2_receipts FOR EACH ROW EXECUTE FUNCTION bill2_evidence_immutable();
DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['bill2_drafts','bill2_runs','bill2_calls','bill2_provider_ids','bill2_receipts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'bill2_%' OR proname IN ('atomic_settle','atomic_refund','atomic_abort_settle','atomic_finalize_ai_success','atomic_finalize_ai_failure','atomic_finalize_ai_abort')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  IF f.proname IN ('bill2_create_draft','bill2_revoke_draft','bill2_read','bill2_prepare','bill2_claim','bill2_dispatch','bill2_record','bill2_close','bill2_cancel','bill2_finalize','bill2_recovery_claim','bill2_pending_calls','bill2_private_input','atomic_settle','atomic_refund','atomic_abort_settle','atomic_finalize_ai_success','atomic_finalize_ai_failure','atomic_finalize_ai_abort') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END IF;
 END LOOP;
END $$;
COMMIT;
