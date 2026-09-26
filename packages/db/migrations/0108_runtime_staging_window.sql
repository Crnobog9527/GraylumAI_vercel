/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- No seed or enablement. Financial state stays in BILL2 runs/calls/receipts.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)') IS NULL
 THEN RAISE EXCEPTION 'RUNTIME_STAGING_REQUIRES_OPC_SCHEMA';END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.runtime_test_windows (
 id uuid PRIMARY KEY,enabled boolean NOT NULL DEFAULT false,
 actor_ids uuid[] NOT NULL CHECK(cardinality(actor_ids) BETWEEN 1 AND 8),
 call_policies jsonb NOT NULL CHECK(jsonb_typeof(call_policies)='array' AND jsonb_array_length(call_policies) BETWEEN 1 AND 16),
 credits_per_usd numeric NOT NULL CHECK(credits_per_usd>0),multiplier numeric NOT NULL CHECK(multiplier>0),
 max_cost_usd numeric NOT NULL CHECK(max_cost_usd>0 AND max_cost_usd<=100),
 max_calls integer NOT NULL CHECK(max_calls BETWEEN 1 AND 1000),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.runtime_test_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_test_windows FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS test_window_id uuid REFERENCES runtime_test_windows(id);
CREATE INDEX IF NOT EXISTS bill2_runs_test_window ON bill2_runs(test_window_id) WHERE test_window_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.runtime_test_window_allowed(a uuid,p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE w runtime_test_windows;entry jsonb;
BEGIN
 IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF p ? 'testWindowId' THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED';END IF;
  RETURN;
 END IF;
 -- Take the exclusive window lock up front; admission later checks its budget.
 -- A share-to-update upgrade would deadlock simultaneous admissions.
 SELECT * INTO w FROM runtime_test_windows WHERE id=(p->>'testWindowId')::uuid FOR UPDATE;
 IF w.id IS NULL OR NOT w.enabled OR NOT(a=ANY(w.actor_ids)) OR clock_timestamp()>=w.expires_at
 OR p->'input'->>'version' IS DISTINCT FROM 'runtime.v1' OR p->'input'->>'network' IS DISTINCT FROM 'deny'
 OR coalesce(p->'input'->'tools','[]'::jsonb) @> '["search"]'::jsonb
 OR p->'rules'->>'version' IS DISTINCT FROM 'runtime-staging-v1'
 OR p->'rules'->>'quoteVersion' IS DISTINCT FROM w.id::text
 OR bill2_decimal(p->'rules'->'creditsPerUsd')<>w.credits_per_usd
 OR bill2_decimal(p->'rules'->'multiplier')<>w.multiplier
 OR (p->'limits'->>'deadline')::timestamptz>w.expires_at
 THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED' USING ERRCODE='42501';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'callPolicy') LOOP
  IF entry->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1' OR entry->>'provider' IS DISTINCT FROM 'openrouter'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.call_policies) allowed WHERE allowed=entry)
  THEN RAISE EXCEPTION 'RUNTIME_TEST_MODEL_DENIED' USING ERRCODE='42501';END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_test_budget_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE w runtime_test_windows;used numeric;calls bigint;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.test_window_id IS DISTINCT FROM OLD.test_window_id THEN RAISE EXCEPTION 'RUNTIME_TEST_IDENTITY_IMMUTABLE';END IF;
  RETURN NEW;
 END IF;
 IF NEW.payload->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF NEW.test_window_id IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED';END IF;
  RETURN NEW;
 END IF;
 -- Serialize all actors/tabs in this window before reading commitments.
 SELECT * INTO w FROM runtime_test_windows WHERE id=(NEW.payload->>'testWindowId')::uuid FOR UPDATE;
 PERFORM runtime_test_window_allowed(NEW.actor_id,NEW.payload);
 SELECT coalesce(sum(CASE WHEN r.closed AND NOT r.conflict AND r.provider_cost_usd IS NOT NULL
   THEN greatest(r.provider_cost_usd,coalesce(c.observed_cost,0))
   ELSE greatest(r.budget_usd,coalesce(c.observed_cost,0)) END),0),
  coalesce(sum(CASE WHEN r.closed THEN coalesce(c.n,0) ELSE r.max_calls END),0)
 INTO used,calls FROM bill2_runs r
 LEFT JOIN LATERAL (SELECT count(*) n,sum(selected_cost_usd) observed_cost FROM bill2_calls WHERE run_id=r.id) c ON true
 WHERE r.test_window_id=w.id;
 IF used+NEW.budget_usd>w.max_cost_usd OR calls+NEW.max_calls>w.max_calls
 THEN RAISE EXCEPTION 'RUNTIME_TEST_BUDGET_EXHAUSTED';END IF;
 NEW.test_window_id:=w.id;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_test_budget_guard ON public.bill2_runs;
CREATE TRIGGER runtime_test_budget_guard BEFORE INSERT OR UPDATE OF test_window_id ON public.bill2_runs
 FOR EACH ROW EXECUTE FUNCTION runtime_test_budget_guard();

CREATE OR REPLACE FUNCTION public.runtime_test_policy(p_actor_id uuid,p_window_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w runtime_test_windows;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO w FROM runtime_test_windows WHERE id=p_window_id;
 IF w.id IS NULL OR NOT w.enabled OR NOT(p_actor_id=ANY(w.actor_ids)) OR clock_timestamp()>=w.expires_at
 THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('id',w.id,'callPolicies',w.call_policies,'creditsPerUsd',w.credits_per_usd::text,
 'multiplier',w.multiplier::text,'expiresAt',w.expires_at);
END $$;

-- Preserve 0107's outer OPC token/material/round guard. Only extend its base.
CREATE OR REPLACE FUNCTION public.runtime_direct_billing_allowed_before_opc(a uuid,p jsonb,p_run_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb;m uuid;k uuid;rev uuid; policy jsonb; entry jsonb; chosen jsonb;matched jsonb;
BEGIN
 PERFORM bill2_actor(a);
 -- Window enablement governs new dispatch, not retained content permissions.
 IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN PERFORM runtime_test_window_allowed(a,p);END IF;
 PERFORM runtime_context_allowed(a,p->'input');
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
 IF p->'input' ? 'matching' THEN
  SELECT e.match_result INTO matched FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.actor_id=a AND r.id=p_run_id AND r.actor_id=a AND r.payload=p;
  SELECT c INTO chosen FROM jsonb_array_elements(p->'input'->'matching'->'candidates') c WHERE c->>'key'=matched->>'key';
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(policy) ORDER BY value->>'modelId' LOOP
  -- After the immutable choice, unused candidate models are not dependencies.
  -- The insertion guard below prevents claims against these unused policies.
  IF matched IS NOT NULL AND entry->>'modelId' IS DISTINCT FROM p->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM chosen->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM p->'input'->'attachedOrganizer'->>'modelId' THEN CONTINUE;END IF;
  PERFORM id FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND (provider=entry->>'provider' OR (p->>'mode'='staging_test' AND entry->>'provider'='openrouter' AND provider IN ('openai','openrouter','anthropic'))) AND is_active='true' FOR SHARE;
  IF NOT FOUND OR entry->>'protocol' IS DISTINCT FROM (CASE WHEN p->>'mode'='staging_test' THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END) OR coalesce(length(entry->>'account'),0)=0
  OR coalesce((entry->>'inputLimit')::int,0) NOT BETWEEN 1 AND 1000000 OR coalesce((entry->>'outputLimit')::int,0) NOT BETWEEN 1 AND 1000000
  OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'automaticRetry' IS DISTINCT FROM 'false'::jsonb OR entry->'hiddenTools' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(entry->'lookupSupported') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 rev:=(p->>'revisionId')::uuid;
 IF rev IS NOT NULL THEN
  m:=(p->>'moduleId')::uuid;k:=(p->>'skillId')::uuid;
  -- Preserve omitted-identity 0105 work requests only when no Runtime binding
  -- exists. runtime_admit requires both selected IDs before calling BILL2;
  -- no payload mode/version flag can opt a Runtime execution into this fallback.
  IF (m IS NULL OR k IS NULL) AND p->'scope'->>'kind'='work_item'
   AND NOT EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id) THEN
   SELECT module_id,skill_id INTO m,k FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid;
  END IF;
  -- Scope ownership/account/source checks above are independent of the
  -- explicitly selected Skill; never replace its identity with the work owner.
  IF EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a) THEN
   PERFORM id FROM modules WHERE id=m AND skill_id=k AND active AND model_id=(p->>'modelId')::uuid FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
  ELSE
   PERFORM id FROM modules WHERE id=m FOR SHARE;
  END IF;
  PERFORM id FROM skills WHERE id=k FOR SHARE;
  PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
  PERFORM read_skill_package(a,m,k,rev,NULL,'');
 END IF;
 -- The original frozen plan remains immutable. A later selection can only
 -- activate one of its candidates and must remain available on every access.
 IF p->'input' ? 'matching' THEN
  SELECT c INTO chosen FROM runtime_executions e,
   LATERAL jsonb_array_elements(e.payload->'matching'->'candidates') c
   WHERE e.actor_id=a AND e.billing_run_id=p_run_id AND EXISTS(SELECT 1 FROM bill2_runs r WHERE r.id=p_run_id AND r.actor_id=a AND r.payload=p)
    AND c->>'key'=e.match_result->>'key';
  IF chosen IS NOT NULL THEN
   m:=(chosen->>'moduleId')::uuid;k:=(chosen->>'skillId')::uuid;rev:=(chosen->>'revisionId')::uuid;
   PERFORM id FROM modules WHERE id=m AND active AND model_id=(chosen->>'modelId')::uuid FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM id FROM skills WHERE id=k FOR SHARE;
   PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM read_skill_package(a,m,k,rev,chosen->>'packageHash','');
  END IF;
 END IF;
END $$;

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
 OR coalesce(p_payload->>'mode','') NOT IN ('isolated','staging_test') OR NOT(p_payload ? 'input')
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
 -- Profile lock serializes this actor; distinct timestamps preserve legacy timestamp-only pagination.
 INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,-reservation,'adjustment','Run reservation','adjustment','bill2_reserve','ai_task',new_id::text,'bill2:'||new_id||':reserve',q.balance_before,q.balance_after,new_id,jsonb_build_object('contractVersion','bill2.v1','preDeductId',q.pre_deduct_id));
 RETURN bill2_public(r);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid,p_run_id uuid,p_sequence integer,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);PERFORM runtime_test_window_allowed(p_actor_id,r.payload);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=r.id AND sequence=p_sequence;
 IF c.id IS NOT NULL THEN IF c.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);END IF;
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0) INTO n,used FROM bill2_calls WHERE run_id=r.id;
 upper_cost:=bill2_decimal(p_payload->'upperUsd');
 IF p_sequence IS DISTINCT FROM n+1 OR n>=r.max_calls OR upper_cost<=0 OR used+upper_cost>r.budget_usd OR ceil((used+upper_cost)*r.credits_per_usd*r.multiplier)>r.reserved
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'callPolicy') policy WHERE policy->>'provider'=p_payload->>'provider' AND policy->>'account'=p_payload->>'account' AND policy->>'model'=p_payload->>'model' AND policy->>'protocol'=p_payload->>'protocol' AND (p_payload->>'inputLimit')::int<=(policy->>'inputLimit')::int AND (p_payload->>'outputLimit')::int<=(policy->>'outputLimit')::int AND upper_cost<=bill2_decimal(policy->'upperUsd') AND policy->'lookupSupported'=p_payload->'lookupSupported' AND policy->'providerLimits' IS NOT DISTINCT FROM p_payload->'providerLimits')
 OR coalesce(length(p_payload->>'provider'),0)=0 OR coalesce(length(p_payload->>'account'),0)=0 OR coalesce(length(p_payload->>'model'),0)=0
 OR coalesce(p_payload->>'requestHash','') !~ '^[a-f0-9]{64}$' OR p_payload->>'protocol' IS DISTINCT FROM (CASE WHEN r.payload->>'mode'='staging_test' THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END)
 OR (p_payload->>'inputLimit') IS NULL OR (p_payload->>'inputLimit')::integer<=0 OR (p_payload->>'outputLimit') IS NULL OR (p_payload->>'outputLimit')::integer<=0
 OR p_payload->>'automaticRetry' IS DISTINCT FROM 'false' OR p_payload->>'hiddenTools' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd) VALUES(r.id,p_sequence,p_payload,p_payload->>'provider',p_payload->>'account',p_payload->>'model',upper_cost) RETURNING * INTO c;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $$;
-- Closing a window blocks new sends while preserving source-checked reads
-- and original-call financial maintenance. No new balance or execution path.
CREATE OR REPLACE FUNCTION public.runtime_test_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;
BEGIN
 IF NEW.dispatched_at IS NOT NULL AND OLD.dispatched_at IS NULL THEN
  SELECT * INTO r FROM bill2_runs WHERE id=NEW.run_id;
  PERFORM runtime_test_window_allowed(r.actor_id,r.payload);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_test_dispatch_guard ON public.bill2_calls;
CREATE TRIGGER runtime_test_dispatch_guard BEFORE UPDATE OF dispatched_at ON public.bill2_calls
 FOR EACH ROW EXECUTE FUNCTION runtime_test_dispatch_guard();

CREATE OR REPLACE FUNCTION public.runtime_test_actor_access(p_actor_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_test_windows WHERE p_actor_id=ANY(actor_ids))
 AND NOT EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND test_window_id IS NOT NULL)
 THEN RAISE EXCEPTION 'RUNTIME_TEST_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_test_recovery_policy(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b bill2_runs;
BEGIN
 SELECT r.* INTO b FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
 WHERE e.id=p_execution_id AND e.actor_id=p_actor_id AND r.actor_id=p_actor_id
 AND r.session_ref=e.session_id AND r.test_window_id IS NOT NULL AND r.payload->>'mode'='staging_test';
 IF b.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_TEST_RECOVERY_DENIED' USING ERRCODE='42501';END IF;
 -- Use the immutable original run, never current window quote/actor overrides.
 RETURN jsonb_build_object('id',b.test_window_id,'callPolicies',b.payload->'callPolicy',
  'creditsPerUsd',b.payload->'rules'->>'creditsPerUsd','multiplier',b.payload->'rules'->>'multiplier',
  'expiresAt',b.deadline);
END $$;
REVOKE ALL ON FUNCTION public.runtime_test_dispatch_guard(),public.runtime_test_actor_access(uuid),public.runtime_test_recovery_policy(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_test_actor_access(uuid),public.runtime_test_recovery_policy(uuid,uuid) TO service_role;
-- Extend existing maintenance eligibility only for a stopped original test window.
CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid,p_execution_id uuid,p_finish boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 IF e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
  ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   UPDATE runtime_executions SET state=CASE WHEN result IS NULL THEN 'cancelled' ELSE 'completed' END WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $$;
REVOKE ALL ON FUNCTION public.runtime_test_window_allowed(uuid,jsonb),public.runtime_test_budget_guard(),public.runtime_test_policy(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_test_policy(uuid,uuid) TO service_role;
COMMIT;
