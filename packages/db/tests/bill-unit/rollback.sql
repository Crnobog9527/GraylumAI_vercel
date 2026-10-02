-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Structural rollback of 0157 for data-free local databases only. Once any run carries
-- payload.rules.billingUnit or any model has a price multiplier, it refuses: settle those with
-- the 0157 functions and fix forward instead.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bill2_runs WHERE jsonb_typeof(payload->'rules'->'billingUnit') = 'object')
     OR EXISTS (SELECT 1 FROM public.ai_models WHERE price_multiplier IS NOT NULL) THEN
    RAISE EXCEPTION 'BILL_UNIT_ROLLBACK_REQUIRES_FORWARD_FIX';
  END IF;
  IF md5(pg_get_functiondef('public.bill2_claim(uuid,uuid,integer,jsonb)'::regprocedure)) <> '0ae1ab95615d8dcbca4e307f5a116a9c'
     OR md5(pg_get_functiondef('public.bill2_finalize(uuid,uuid)'::regprocedure)) <> 'afa97ab976e30d66967523103bfc06f0' THEN
    RAISE EXCEPTION 'BILL_UNIT_ROLLBACK_SOURCE_MISMATCH';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_finalize(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

DROP FUNCTION public.bill2_admin_call_report(timestamptz, timestamptz, integer);
DROP INDEX public.bill2_calls_created_at;
DROP FUNCTION public.bill2_unit_multiplier(jsonb);
ALTER TABLE public.ai_models DROP CONSTRAINT ai_models_price_multiplier_check;
ALTER TABLE public.ai_models DROP COLUMN price_multiplier;
COMMIT;
