-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-UNIT (#565), numbered 0157 after #497 (0155) and #550 (0156); remote application needs separate Owner approval.
--
-- 1. ai_models.price_multiplier: per-model m, NULL inherits system_settings.billing_token_price_multiplier.
-- 2. bill2_claim / bill2_finalize: a run whose payload.rules carries a billingUnit object (new contract)
--    freezes m_i on every call (payload.billingUnit.multiplier, equal to its callPolicy entry) and owes
--    ceil(q × Σ(cost_i × m_i)), rounded once. Runs without billingUnit keep the original ceil(Σcost × q × m)
--    branch unchanged; bill2_prepare is untouched (rules.multiplier is the run's maximum m_i).
-- 3. bill2_admin_call_report: read-only, service_role-only financial projection for /admin/finance.
--
-- Source drift aborts before any change (md5 of the exact 0105/0108 definitions or this file's output).
-- Rollback (packages/db/tests/bill-unit/rollback.sql) is for data-free local databases only; once a run
-- carries billingUnit it refuses and a forward fix is required.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF md5(pg_get_functiondef('public.bill2_claim(uuid,uuid,integer,jsonb)'::regprocedure))
     NOT IN ('02098dafa607915d21d522cb8009ad7d', '0ae1ab95615d8dcbca4e307f5a116a9c') THEN
    RAISE EXCEPTION 'BILL_UNIT_SOURCE_MISMATCH: bill2_claim(uuid,uuid,integer,jsonb)';
  END IF;
  IF md5(pg_get_functiondef('public.bill2_finalize(uuid,uuid)'::regprocedure))
     NOT IN ('3cfbdaaa3d94c1d8ac09faffa8b8bf52', 'afa97ab976e30d66967523103bfc06f0') THEN
    RAISE EXCEPTION 'BILL_UNIT_SOURCE_MISMATCH: bill2_finalize(uuid,uuid)';
  END IF;
END $$;

-- 1. Per-model multiplier. Unconstrained numeric plus CHECK so over-precise values are rejected, not rounded.
ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS price_multiplier numeric;
DO $$
BEGIN
  -- ADD COLUMN IF NOT EXISTS silently keeps a pre-existing column of another type; refuse that.
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.ai_models'::regclass AND attname = 'price_multiplier' AND NOT attisdropped)
     IS DISTINCT FROM 'numeric' THEN
    RAISE EXCEPTION 'BILL_UNIT_PRICE_MULTIPLIER_TYPE_MISMATCH';
  END IF;
END $$;
ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_price_multiplier_check;
ALTER TABLE public.ai_models ADD CONSTRAINT ai_models_price_multiplier_check CHECK (
  price_multiplier IS NULL
  OR (price_multiplier >= 1 AND price_multiplier <= 20 AND scale(price_multiplier) <= 2)
);
COMMENT ON COLUMN public.ai_models.price_multiplier IS
  'BILL-UNIT per-model price multiplier (1-20, at most 2 decimals); NULL inherits billing_token_price_multiplier.';

-- 2. Per-call frozen multiplier: text form 1-20 with at most two decimals, never rounded.
CREATE OR REPLACE FUNCTION public.bill2_unit_multiplier(v jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string'
     OR (v #>> '{}') !~ '^(([1-9]|1[0-9])(\.[0-9]{1,2})?|20(\.0{1,2})?)$' THEN
    RAISE EXCEPTION 'BILL2_UNIT_MULTIPLIER_INVALID';
  END IF;
  RETURN (v #>> '{}')::numeric;
END $$;
REVOKE ALL ON FUNCTION public.bill2_unit_multiplier(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;weighted boolean;wused numeric;m_call numeric;
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
 -- BILL-UNIT: a run whose rules carry billingUnit freezes m_i per call; the old single-m branch is unchanged.
 weighted:=coalesce(jsonb_typeof(r.payload->'rules'->'billingUnit')='object',false);
 IF weighted THEN
  m_call:=bill2_unit_multiplier(p_payload->'billingUnit'->'multiplier');
  SELECT coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd)*bill2_unit_multiplier(payload->'billingUnit'->'multiplier') END),0)
  INTO wused FROM bill2_calls WHERE run_id=r.id;
 END IF;
 IF p_sequence IS DISTINCT FROM n+1 OR n>=r.max_calls OR upper_cost<=0 OR used+upper_cost>r.budget_usd OR (CASE WHEN weighted THEN ceil((wused+upper_cost*m_call)*r.credits_per_usd)>r.reserved ELSE ceil((used+upper_cost)*r.credits_per_usd*r.multiplier)>r.reserved END)
 OR (CASE WHEN weighted THEN bill2_decimal(r.payload->'rules'->'billingUnit'->'creditsPerUsd') IS DISTINCT FROM r.credits_per_usd OR m_call>r.multiplier ELSE false END)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'callPolicy') policy WHERE policy->>'provider'=p_payload->>'provider' AND policy->>'account'=p_payload->>'account' AND policy->>'model'=p_payload->>'model' AND policy->>'protocol'=p_payload->>'protocol' AND (p_payload->>'inputLimit')::int<=(policy->>'inputLimit')::int AND (p_payload->>'outputLimit')::int<=(policy->>'outputLimit')::int AND upper_cost<=bill2_decimal(policy->'upperUsd') AND policy->'lookupSupported'=p_payload->'lookupSupported' AND policy->'providerLimits' IS NOT DISTINCT FROM p_payload->'providerLimits' AND (NOT weighted OR (policy->>'modelId'=p_payload->'billingUnit'->>'modelId' AND policy->'multiplier'=p_payload->'billingUnit'->'multiplier')))
 OR coalesce(length(p_payload->>'provider'),0)=0 OR coalesce(length(p_payload->>'account'),0)=0 OR coalesce(length(p_payload->>'model'),0)=0
 OR coalesce(p_payload->>'requestHash','') !~ '^[a-f0-9]{64}$' OR p_payload->>'protocol' IS DISTINCT FROM (CASE WHEN r.payload->>'mode'='staging_test' THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END)
 OR (p_payload->>'inputLimit') IS NULL OR (p_payload->>'inputLimit')::integer<=0 OR (p_payload->>'outputLimit') IS NULL OR (p_payload->>'outputLimit')::integer<=0
 OR p_payload->>'automaticRetry' IS DISTINCT FROM 'false' OR p_payload->>'hiddenTools' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd) VALUES(r.id,p_sequence,p_payload,p_payload->>'provider',p_payload->>'account',p_payload->>'model',upper_cost) RETURNING * INTO c;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_finalize(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;n integer;pending integer;cost numeric;credits integer:=0;before_balance integer;after_balance integer;restored integer;release_amount integer;spent uuid;meta jsonb;q record;weighted_cost numeric;
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
 -- BILL-UNIT: N = ceil(q × Σ(cost_i × m_i)), rounded once; runs without billingUnit keep ceil(Σcost × q × m).
 IF jsonb_typeof(r.payload->'rules'->'billingUnit')='object' THEN
  SELECT coalesce(sum(selected_cost_usd*bill2_unit_multiplier(payload->'billingUnit'->'multiplier')),0) INTO weighted_cost
  FROM bill2_calls WHERE run_id=r.id AND selected_cost_usd IS NOT NULL;
 END IF;
 IF n>0 AND r.outcome IS DISTINCT FROM 'confirmed_failure' THEN
  IF r.conflict OR pending>0 OR r.outcome='unknown' THEN RETURN bill2_public(r);END IF;
  IF r.outcome IS NULL OR r.outcome NOT IN ('delivered','cancelled') THEN RAISE EXCEPTION 'BILL2_OUTCOME_REQUIRED';END IF;
  IF cost>r.budget_usd OR ceil(CASE WHEN weighted_cost IS NULL THEN cost*r.credits_per_usd*r.multiplier ELSE weighted_cost*r.credits_per_usd END)>r.reserved THEN
   UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;RETURN bill2_public(r);END IF;
  credits:=ceil(CASE WHEN weighted_cost IS NULL THEN cost*r.credits_per_usd*r.multiplier ELSE weighted_cost*r.credits_per_usd END)::integer;
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
 INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,release_amount,'adjustment','Run reservation release','adjustment','bill2_release','ai_task',r.id::text,'bill2:'||r.id||':release',before_balance,before_balance::bigint+release_amount,r.id,meta||jsonb_build_object('nominalReserved',r.reserved,'actualRestore',restored,'intercepted',r.reserved-release_amount));
 IF n>0 AND r.outcome<>'confirmed_failure' THEN
  INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
  VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,-credits,'consumption','AI run consumption','spend','bill2_spend','ai_task',r.id::text,'bill2:'||r.id||':spend',before_balance::bigint+release_amount,after_balance,r.id,meta) RETURNING id INTO spent;
  UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=r.pre_deduct_id::text;
  INSERT INTO token_stats(bill2_run_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
  VALUES(r.id,p_actor_id,'bill2.aggregate',bill2_usage_total(r.id,'inputTokens'),bill2_usage_total(r.id,'outputTokens'),bill2_usage_total(r.id,'cachedTokens'),bill2_usage_total(r.id,'cacheCreationTokens'),bill2_usage_total(r.id,'webSearchCount'),cost,credits,meta||jsonb_build_object('usageInPrivateReceipts',true));
  INSERT INTO ai_usage_logs(bill2_run_id,user_id,request_id,model_id,status,metadata)
  VALUES(r.id,p_actor_id,r.request_id::text,'bill2.aggregate','success',meta);
 END IF;
 UPDATE bill2_runs SET state=CASE WHEN n=0 OR outcome='confirmed_failure' THEN 'refunded' ELSE 'settled' END,
 charged=credits,actual_restore=restored,provider_cost_usd=CASE WHEN pending=0 THEN cost ELSE NULL END,version=version+1 WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_public(r);
END $function$;

-- 3. Read-only per-call finance projection. bill2_runs / bill2_calls stay revoked from every API role (0105);
-- this returns financial columns only (no actor, request, scope, prompt or receipt body), numbers as text.
CREATE INDEX IF NOT EXISTS bill2_calls_created_at ON public.bill2_calls(created_at, id);
CREATE OR REPLACE FUNCTION public.bill2_admin_call_report(p_from timestamptz, p_to timestamptz, p_limit integer)
RETURNS TABLE (
  call_id uuid, run_id uuid, call_sequence integer, created_at timestamptz,
  provider text, model text, call_state text, selected_cost_usd text,
  run_state text, run_outcome text, credits_per_usd text, run_multiplier text,
  run_charged integer, run_actual_restore integer, run_call_count integer,
  call_multiplier text, multiplier_source text, purpose text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.run_id, c.sequence, c.created_at,
         c.provider, c.model, c.state, c.selected_cost_usd::text,
         r.state, r.outcome, r.credits_per_usd::text, r.multiplier::text,
         r.charged, r.actual_restore, (SELECT count(*)::integer FROM bill2_calls x WHERE x.run_id = r.id),
         c.payload #>> '{billingUnit,multiplier}', c.payload #>> '{billingUnit,source}',
         r.payload #>> '{purposeBudget,purpose}'
  FROM bill2_calls c
  JOIN bill2_runs r ON r.id = c.run_id
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND c.created_at >= p_from AND c.created_at < p_to
  ORDER BY c.created_at, c.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 1), 1), 5000)
$$;
REVOKE ALL ON FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer) TO service_role;

COMMIT;
