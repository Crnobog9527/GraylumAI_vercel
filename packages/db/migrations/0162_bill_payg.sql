-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-PAYG PR-A. Default admission remains v1. No remote application authorization.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
 IF md5(pg_get_functiondef('public.account_erasure_financial_batch(integer,uuid,uuid)'::regprocedure)) NOT IN ('9b930e32526b059e57eea56092b7819b','3ebe395fa1d4cc1d292f89c1673d7fe6') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: account_erasure_financial_batch(integer,uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)'::regprocedure)) NOT IN ('672a40270b1c4606091e7a50497744e0','8bdddf9345dfc95ab136888cf31f4370') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)';END IF;
 IF md5(pg_get_functiondef('public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)'::regprocedure)) NOT IN ('002ec150620c3615fbc379c007d92f8a','732d658db9f7f4864424cef1850ab4e6') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)';END IF;
 IF md5(pg_get_functiondef('public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)'::regprocedure)) NOT IN ('995f518dcc2672d55ad3d9f5cc4ce897','d2fab8cafcc5da33beb6e00065aa8560') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)'::regprocedure)) NOT IN ('9061b3b7770312cafb8adce344d908b2','3695e9274e5c8fbe01804f896a2ada7f') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)';END IF;
 IF md5(pg_get_functiondef('public.atomic_pre_deduct(uuid,integer,text,uuid)'::regprocedure)) NOT IN ('6ad1042b32e2c29f91ecbf92e8cd23b1','6ad1042b32e2c29f91ecbf92e8cd23b1') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_pre_deduct(uuid,integer,text,uuid)';END IF;
 IF md5(pg_get_functiondef('public.atomic_refund(uuid,uuid,text)'::regprocedure)) NOT IN ('ed7d27ae178168a87c979b30f86c6780','29106b911bae03c46c4cbc68ba194b01') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_refund(uuid,uuid,text)';END IF;
 IF md5(pg_get_functiondef('public.atomic_settle(uuid,uuid,integer,jsonb,jsonb)'::regprocedure)) NOT IN ('1769f87891f84452f4101fb76d3e5889','cb7a617d25e30e471ec30a57a24cfa33') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: atomic_settle(uuid,uuid,integer,jsonb,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_admin_call_report(timestamp with time zone,timestamp with time zone,integer)'::regprocedure)) NOT IN ('7a605b5b79509eaeca6fd88c56fa4b15','be2750ce603c9adaabc8b8c01860ff96') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_admin_call_report(timestamp with time zone,timestamp with time zone,integer)';END IF;
 IF md5(pg_get_functiondef('public.bill2_claim(uuid,uuid,integer,jsonb)'::regprocedure)) NOT IN ('0ae1ab95615d8dcbca4e307f5a116a9c','4af4832f8be4acf51af5fc6a6648ea9a') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_claim(uuid,uuid,integer,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_close(uuid,uuid,text,jsonb)'::regprocedure)) NOT IN ('cdd624f5aba3b08481c2e9f0ddfcaad0','82875781889b3a01d8ac66a862e84e75') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_close(uuid,uuid,text,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure)) NOT IN ('6b277ab43fd91f4d481ffe9264ddbe8c','3a41fc21404ee5b541760704a9f7a387') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_erasure_closed(uuid,uuid)'::regprocedure)) NOT IN ('005b38646ee005456a08099115307910','f5347a577dcef55b83e90e0662ac7b3e') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_erasure_closed(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_finalize(uuid,uuid)'::regprocedure)) NOT IN ('afa97ab976e30d66967523103bfc06f0','4b188addd7ab9ab612d11f76ac6f82c2') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_finalize(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_financial_projection(jsonb)'::regprocedure)) NOT IN ('373a819a343e157366d7edc2ce592080','c41ef6e51f41f74f02a89ddf082e6390') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_financial_projection(jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_abort_settle(uuid,uuid,integer,jsonb,text,text)'::regprocedure)) NOT IN ('fe13a9e7fb0de31149dc3b3604ed456d','fe13a9e7fb0de31149dc3b3604ed456d') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_abort_settle(uuid,uuid,integer,jsonb,text,text)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_finalize_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)'::regprocedure)) NOT IN ('096f93ae1f0451a80e0ab83c81647ead','096f93ae1f0451a80e0ab83c81647ead') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_finalize_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_finalize_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)'::regprocedure)) NOT IN ('3dae5afacab4b8501de4ab4927e9c909','3dae5afacab4b8501de4ab4927e9c909') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_finalize_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_finalize_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)'::regprocedure)) NOT IN ('a1715525a036768da523ae060c424058','a1715525a036768da523ae060c424058') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_finalize_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_refund(uuid,uuid,text)'::regprocedure)) NOT IN ('1c4b313385f820f29de85b766b4579a9','1c4b313385f820f29de85b766b4579a9') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_refund(uuid,uuid,text)';END IF;
 IF md5(pg_get_functiondef('public.bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)'::regprocedure)) NOT IN ('34649375016ed0d04a6ac6c5f266f7e5','34649375016ed0d04a6ac6c5f266f7e5') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_pending_calls(uuid,uuid)'::regprocedure)) NOT IN ('7915d79240e0c7e95356bf978b49a8fb','a561dbeaf32edd0c0611a31f8b168b13') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_pending_calls(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_prepare(uuid,uuid,jsonb)'::regprocedure)) NOT IN ('ca650d9b1be2c848b59c2b5c75c2f938','4e042010b12733ebef25806b358ccbcc') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_prepare(uuid,uuid,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_public(bill2_runs)'::regprocedure)) NOT IN ('ee3e38d853c7786f2460a0e186b6855b','56429305d4e554d5a5eb0a6a2bc00839') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_public(bill2_runs)';END IF;
 IF md5(pg_get_functiondef('public.bill2_read(uuid,uuid)'::regprocedure)) NOT IN ('703cec867c8de958080e2e7f38c5a919','176d8fd845f7c3d7e62c9d01a8f3b46e') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_read(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_record(uuid,uuid,uuid,jsonb)'::regprocedure)) NOT IN ('230e64de05ffe4f4e7181087d838470b','347c4ed918e43f9759cd040554fe091d') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_record(uuid,uuid,uuid,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_recovery_claim(uuid,uuid,uuid)'::regprocedure)) NOT IN ('938c81c99aa41a4bdcaa8e2a596075f4','2fe2d395ec29da937121faf957245f4c') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_recovery_claim(uuid,uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure)) NOT IN ('59bb3d3fea517e5638fc78241c192bf8','e8d056e17c4dfc9d52b7770e8e34c6b3') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)';END IF;
 IF md5(pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure)) NOT IN ('0d366951817eb3218256c81d060ee026','8b4ef3b787caf790ab5510c61dd07883') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: runtime_financial_recovery(uuid,uuid,boolean)';END IF;
 IF md5(pg_get_functiondef('public.runtime_test_budget_guard()'::regprocedure)) NOT IN ('2d6b766e9825f0caec8e9941805b80dd','6b73ed6b31272f9f75c0f90845901501') THEN RAISE EXCEPTION 'PAYG_SOURCE_MISMATCH: runtime_test_budget_guard()';END IF;
 IF to_regprocedure('public.bill2_payg_absorb_report(timestamp with time zone,timestamp with time zone)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_absorb_report(timestamp with time zone,timestamp with time zone)'))) <> '336c3faed08c1925c71391b4b47bf7c2' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_absorb_report(timestamp with time zone,timestamp with time zone)';END IF;
 IF to_regprocedure('public.bill2_payg_claim(uuid,uuid,integer,jsonb)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'))) <> '52e397d4738ce026df10579f3b2dc38d' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_claim(uuid,uuid,integer,jsonb)';END IF;
 IF to_regprocedure('public.bill2_payg_compensate(bill2_runs,bill2_calls)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_compensate(bill2_runs,bill2_calls)'))) <> '8daa785df26e308a09663bb4714caf32' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_compensate(bill2_runs,bill2_calls)';END IF;
 IF to_regprocedure('public.bill2_payg_finalize(uuid,uuid)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_finalize(uuid,uuid)'))) <> '1625da8f6a13a74250f7c454e84319ea' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_finalize(uuid,uuid)';END IF;
 IF to_regprocedure('public.bill2_payg_financial_binding(bill2_runs)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_financial_binding(bill2_runs)'))) <> 'c6515b16f4db74ac09b4f2e4558f6c1d' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_financial_binding(bill2_runs)';END IF;
 IF to_regprocedure('public.bill2_payg_lock_models(bill2_runs)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_lock_models(bill2_runs)'))) <> 'e34331b9c52ec8cfa83c0639530dea75' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_lock_models(bill2_runs)';END IF;
 IF to_regprocedure('public.bill2_payg_nominal(jsonb,jsonb)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_nominal(jsonb,jsonb)'))) <> '62ad045bdebe8cca129707146ec53a8a' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_nominal(jsonb,jsonb)';END IF;
 IF to_regprocedure('public.bill2_payg_prices(jsonb,bigint)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_prices(jsonb,bigint)'))) <> '3ce50167ab077ea5328a3b6b140981d4' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_prices(jsonb,bigint)';END IF;
 IF to_regprocedure('public.bill2_payg_validate_quote(bill2_runs,jsonb)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.bill2_payg_validate_quote(bill2_runs,jsonb)'))) <> '1d2f752ed19849bfc5797d38288cf13c' THEN RAISE EXCEPTION 'PAYG_TARGET_MISMATCH: bill2_payg_validate_quote(bill2_runs,jsonb)';END IF;
END $$;

ALTER TABLE bill2_runs DROP CONSTRAINT IF EXISTS bill2_runs_contract_version_check;
ALTER TABLE bill2_runs ADD CONSTRAINT bill2_runs_contract_version_check CHECK(contract_version IN ('bill2.v1','bill2.v2'));
ALTER TABLE bill2_runs DROP CONSTRAINT IF EXISTS bill2_runs_reserved_check;
ALTER TABLE bill2_runs ADD CONSTRAINT bill2_runs_reserved_check CHECK(
 (contract_version='bill2.v1' AND reserved>0) OR (contract_version='bill2.v2' AND reserved=0 AND pre_deduct_id IS NULL));
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS nominal_cost_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS weighted_nominal_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS theoretical_credits numeric NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS platform_absorbed_credits numeric NOT NULL DEFAULT 0;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS paused_reason text;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS pre_deduct_id uuid UNIQUE REFERENCES billing_history(id);
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS reserved_credits integer;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS available_credits integer;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS start_threshold integer;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS threshold_version text;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS nominal_cost_usd numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS nominal_reconstructed_usd numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS nominal_source text;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS theoretical_delta numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS charged_delta integer;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS platform_absorbed_cap_credits numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS platform_absorbed_bound_credits numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS budget_conflict boolean NOT NULL DEFAULT false;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS metering_missing boolean NOT NULL DEFAULT false;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS reconciliation_anomaly boolean NOT NULL DEFAULT false;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS platform_margin_cache_read_usd numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS platform_margin_cache_write_usd numeric;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS platform_margin_other_usd numeric;
ALTER TABLE bill2_calls DROP CONSTRAINT IF EXISTS bill2_payg_call_finance;
ALTER TABLE bill2_calls ADD CONSTRAINT bill2_payg_call_finance CHECK (
 (pre_deduct_id IS NULL AND reserved_credits IS NULL) OR
 (pre_deduct_id IS NOT NULL AND reserved_credits>0 AND available_credits>=reserved_credits
  AND start_threshold>0 AND available_credits>=start_threshold
  AND (settled_at IS NULL OR (charged_delta BETWEEN 0 AND reserved_credits
   AND theoretical_delta=charged_delta+platform_absorbed_cap_credits+platform_absorbed_bound_credits
   AND platform_absorbed_cap_credits>=0 AND platform_absorbed_bound_credits>=0))));
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS bill2_call_id uuid REFERENCES bill2_calls(id);
ALTER TABLE token_stats ADD COLUMN IF NOT EXISTS bill2_call_id uuid REFERENCES bill2_calls(id);
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS bill2_call_id uuid REFERENCES bill2_calls(id);
DROP INDEX IF EXISTS credit_transactions_bill2_phase;
CREATE UNIQUE INDEX credit_transactions_bill2_phase ON credit_transactions(bill2_run_id,reason_code)
 WHERE bill2_run_id IS NOT NULL AND bill2_call_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_bill2_call_phase ON credit_transactions(bill2_call_id,reason_code)
 WHERE bill2_call_id IS NOT NULL;
DROP INDEX IF EXISTS token_stats_bill2_run;
CREATE UNIQUE INDEX token_stats_bill2_run ON token_stats(bill2_run_id) WHERE bill2_run_id IS NOT NULL AND bill2_call_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS token_stats_bill2_call ON token_stats(bill2_call_id) WHERE bill2_call_id IS NOT NULL;
DROP INDEX IF EXISTS ai_usage_logs_bill2_run;
CREATE UNIQUE INDEX ai_usage_logs_bill2_run ON ai_usage_logs(bill2_run_id) WHERE bill2_run_id IS NOT NULL AND bill2_call_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_logs_bill2_call ON ai_usage_logs(bill2_call_id) WHERE bill2_call_id IS NOT NULL;

ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS compensation_credits integer;
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS compensated_at timestamptz;
ALTER TABLE bill2_runs ADD COLUMN IF NOT EXISTS compensation_credits integer NOT NULL DEFAULT 0;

ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS metering_exit boolean NOT NULL DEFAULT false;

-- Serialize model monitoring against every new v2 claim before wallet/window locks.
CREATE OR REPLACE FUNCTION bill2_payg_lock_models(r bill2_runs) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k bigint;BEGIN
 IF r.contract_version<>'bill2.v2' THEN RETURN;END IF;
 FOR k IN SELECT DISTINCT hashtextextended('bill2-payg:'||(x->>'model'),0)
  FROM jsonb_array_elements(r.payload->'callPolicy') x ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(k);
 END LOOP;
END $$;
-- Validate the original financial binding even after content/account closure.
CREATE OR REPLACE FUNCTION bill2_payg_financial_binding(r bill2_runs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.contract_version='bill2.v1' THEN EXISTS(SELECT 1 FROM billing_history
  WHERE id=r.pre_deduct_id AND user_id=r.actor_id AND operation_type='pre_deduct')
 ELSE r.contract_version='bill2.v2' AND r.pre_deduct_id IS NULL AND r.reserved=0 AND NOT EXISTS(
  SELECT 1 FROM bill2_calls c LEFT JOIN billing_history h ON h.id=c.pre_deduct_id
  WHERE c.run_id=r.id AND (h.id IS NULL OR h.user_id IS DISTINCT FROM r.actor_id
   OR h.operation_type IS DISTINCT FROM 'pre_deduct' OR h.metadata->>'requestId' IS DISTINCT FROM c.id::text
   OR abs(h.amount) IS DISTINCT FROM c.reserved_credits)) END
$$;
CREATE OR REPLACE FUNCTION bill2_erasure_closed(a uuid,pre uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;
BEGIN
 IF a IS NULL OR NOT EXISTS(SELECT 1 FROM profiles p JOIN account_erasure_requests e ON e.profile_id=p.id
  WHERE p.id=a AND p.status='deleted' AND p.is_deleted='true') THEN RETURN false;END IF;
 SELECT * INTO r FROM bill2_runs WHERE actor_id=a AND
  ((contract_version='bill2.v1' AND pre_deduct_id=pre) OR (contract_version='bill2.v2' AND id=pre));
 RETURN r.id IS NOT NULL AND bill2_payg_financial_binding(r);
END $$;
-- SQL numeric retains 18-digit token-price precision; no per-call rounding.
CREATE OR REPLACE FUNCTION bill2_payg_prices(p jsonb,t bigint) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE entry jsonb;v jsonb;k text;last_t bigint:=-1;threshold bigint;
BEGIN
 IF p->>'version' IS DISTINCT FROM 'nominal-v1' OR coalesce(p->>'pricingHash','') !~ '^[a-f0-9]{64}$'
 OR coalesce(length(p->>'endpointTag'),0) NOT BETWEEN 1 AND 128
 OR jsonb_typeof(p->'tiers') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'timeOfDay') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p->'tiers')<1 OR jsonb_array_length(p->'tiers')+jsonb_array_length(p->'timeOfDay')>17
 THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'tiers') LOOP
  IF coalesce(entry->>'minPromptTokens','') !~ '^(0|[1-9][0-9]{0,9})$' THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
  threshold:=(entry->>'minPromptTokens')::bigint;
  IF threshold<=last_t OR (last_t=-1 AND threshold<>0) THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
  last_t:=threshold;
  IF NOT coalesce(entry ?& ARRAY['prompt','completion','request'],false) THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
  FOREACH k IN ARRAY ARRAY['prompt','completion','request'] LOOP PERFORM bill2_decimal(entry->k);END LOOP;
  IF entry ? 'internalReasoning' THEN PERFORM bill2_decimal(entry->'internalReasoning');END IF;
  FOREACH k IN ARRAY ARRAY['cacheRead','cacheWrite'] LOOP
   IF entry ? k THEN PERFORM bill2_decimal(entry->k);END IF;
  END LOOP;
  IF threshold<=t THEN v:=entry;END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'timeOfDay') LOOP
  IF entry ? 'minPromptTokens' AND coalesce(entry->>'minPromptTokens','') !~ '^[1-9][0-9]{0,9}$' THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
  IF NOT coalesce(entry ?& ARRAY['prompt','completion','request'],false) THEN RAISE EXCEPTION 'BILL2_NOMINAL_PRICING_INVALID';END IF;
  FOREACH k IN ARRAY ARRAY['prompt','completion','request'] LOOP PERFORM bill2_decimal(entry->k);END LOOP;
  IF entry ? 'internalReasoning' THEN PERFORM bill2_decimal(entry->'internalReasoning');END IF;
  FOREACH k IN ARRAY ARRAY['cacheRead','cacheWrite'] LOOP
   IF entry ? k THEN PERFORM bill2_decimal(entry->k);END IF;
  END LOOP;
  IF coalesce((entry->>'minPromptTokens')::bigint,0)<=t THEN
   FOREACH k IN ARRAY ARRAY['cacheRead','cacheWrite'] LOOP
    IF v ? k AND entry ? k THEN v:=jsonb_set(v,ARRAY[k],to_jsonb(greatest(bill2_decimal(v->k),bill2_decimal(entry->k))::text));
    ELSE v:=v-k;END IF;
   END LOOP;
   -- Effective reasoning must include each layer's completion fallback.
   v:=v||jsonb_build_object('internalReasoning',greatest(bill2_decimal(coalesce(v->'internalReasoning',v->'completion')),
    bill2_decimal(coalesce(entry->'internalReasoning',entry->'completion')))::text);
   FOREACH k IN ARRAY ARRAY['prompt','completion','request'] LOOP
    v:=jsonb_set(v,ARRAY[k],to_jsonb(greatest(bill2_decimal(v->k),bill2_decimal(entry->k))::text));
   END LOOP;
  END IF;
 END LOOP;
 RETURN v;
END $$;
CREATE OR REPLACE FUNCTION bill2_payg_nominal(p jsonb,u jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE k text;prices jsonb;pt bigint;ot bigint;rt bigint;cp numeric;rp numeric;
BEGIN
 FOREACH k IN ARRAY ARRAY['inputTokens','outputTokens','reasoningTokens'] LOOP
  IF u->>k IS NOT NULL AND u->>k !~ '^(0|[1-9][0-9]{0,9})$' THEN RAISE EXCEPTION 'BILL2_NOMINAL_TOKEN_CONFLICT';END IF;
 END LOOP;
 IF u->>'inputTokens' IS NULL OR u->>'outputTokens' IS NULL THEN RETURN NULL;END IF;
 pt:=(u->>'inputTokens')::bigint;ot:=(u->>'outputTokens')::bigint;rt:=(u->>'reasoningTokens')::bigint;
 IF rt>ot THEN RAISE EXCEPTION 'BILL2_NOMINAL_TOKEN_CONFLICT';END IF;
 prices:=bill2_payg_prices(p,pt);cp:=bill2_decimal(prices->'completion');rp:=bill2_decimal(coalesce(prices->'internalReasoning',prices->'completion'));
 IF cp<>rp AND rt IS NULL THEN RETURN NULL;END IF;
 RETURN (pt*bill2_decimal(prices->'prompt')+(ot-coalesce(rt,0))*cp+coalesce(rt,0)*rp)/1000000+bill2_decimal(prices->'request');
END $$;
CREATE OR REPLACE FUNCTION bill2_payg_validate_quote(r bill2_runs,p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE stable jsonb;v jsonb:=p->'payg';q jsonb;limits jsonb:=p->'providerLimits';entry jsonb;k text;t bigint;o bigint;u numeric;price numeric;
BEGIN
 SELECT x INTO stable FROM jsonb_array_elements(r.payload->'callPolicy') x WHERE
  x->>'provider'=p->>'provider' AND x->>'account'=p->>'account' AND x->>'model'=p->>'model'
  AND x->>'protocol'=p->>'protocol' AND x->>'modelId'=p->'billingUnit'->>'modelId'
  AND x->'multiplier'=p->'billingUnit'->'multiplier' AND x->'lookupSupported'=p->'lookupSupported'
  AND x->'providerLimits'=limits AND x->'payg'->>'policyId'=v->>'policyId';
 q:=stable->'payg';
 IF NOT coalesce(q ?& ARRAY['version','policyId','expiresAt','purposes','admissionPath','maxBytes','maxMessages','maxTools','maxSchemaBytes'],false)
 OR NOT coalesce(limits ?& ARRAY['contextTokens','promptUsdPerMillion','completionUsdPerMillion','requestUsd'],false)
 THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['maxBytes','maxMessages','maxTools','maxSchemaBytes'] LOOP
  IF coalesce(q->>k,'') !~ '^(0|[1-9][0-9]{0,6})$' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 END LOOP;
 IF stable IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR jsonb_typeof(q) IS DISTINCT FROM 'object'
 OR q->>'version' IS DISTINCT FROM v->>'policyVersion' OR q->'nominalPricing' IS DISTINCT FROM v->'nominalPricing'
 OR coalesce(q->>'policyId','')='' OR coalesce(q->>'version','')=''
 OR coalesce(q->>'expiresAt','')='' OR (q->>'expiresAt')::timestamptz<=clock_timestamp()
 OR NOT coalesce(q->'purposes' ? (p->>'phase'),false)
 OR coalesce(p->>'requestHash','') !~ '^[a-f0-9]{64}$'
 OR p->>'automaticRetry' IS DISTINCT FROM 'false' OR p->>'hiddenTools' IS DISTINCT FROM 'false'
 OR coalesce(q->>'admissionPath','') NOT IN ('fixture','empirical','tokenizer')
 OR (p->>'protocol'='fixture-cost-v1') IS DISTINCT FROM (q->>'admissionPath'='fixture')
 THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['profileVersion','evidenceVersion','pricingHash','endpointTag','templateTokens','marginTokens'] LOOP
  IF v->k IS DISTINCT FROM q->k OR coalesce(v->>k,'')='' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 END LOOP;
 IF v->'nominalPricing'->>'pricingHash' IS DISTINCT FROM v->>'pricingHash'
 OR v->'nominalPricing'->>'endpointTag' IS DISTINCT FROM v->>'endpointTag'
 OR limits->>'providerSlug' IS DISTINCT FROM v->>'endpointTag' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['bytes','templateTokens','marginTokens','promptTokensUpper','messages','tools','schemaBytes'] LOOP
  IF coalesce(v->>k,'') !~ '^(0|[1-9][0-9]{0,6})$' THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 END LOOP;
 t:=(v->>'promptTokensUpper')::bigint;o:=(p->>'outputLimit')::bigint;
 IF t<>(v->>'bytes')::bigint+(v->>'templateTokens')::bigint+(v->>'marginTokens')::bigint
 OR (v->>'bytes')::int NOT BETWEEN 1 AND least((q->>'maxBytes')::int,196608)
 OR (v->>'bytes')::int>(p->>'inputLimit')::int OR (p->>'inputLimit')::int>(stable->>'inputLimit')::int
 OR (v->>'messages')::int NOT BETWEEN 1 AND least((q->>'maxMessages')::int,32)
 OR (v->>'tools')::int>least((q->>'maxTools')::int,2)
 OR (v->>'schemaBytes')::int>least((q->>'maxSchemaBytes')::int,16384)
 OR o IS NULL OR o NOT BETWEEN 1 AND (stable->>'outputLimit')::int
 OR t+o>(limits->>'contextTokens')::bigint THEN RAISE EXCEPTION 'BILL2_PAYG_QUOTE_INVALID';END IF;
 PERFORM bill2_payg_prices(v->'nominalPricing',t);
 FOR entry IN SELECT value FROM jsonb_array_elements(v->'nominalPricing'->'tiers')
  UNION ALL SELECT value FROM jsonb_array_elements(v->'nominalPricing'->'timeOfDay') LOOP
  IF coalesce((entry->>'minPromptTokens')::bigint,0)<=t AND
   (bill2_decimal(entry->'prompt')>bill2_decimal(limits->'promptUsdPerMillion')
   OR greatest(bill2_decimal(entry->'completion'),bill2_decimal(coalesce(entry->'internalReasoning',entry->'completion')))>bill2_decimal(limits->'completionUsdPerMillion')
   OR bill2_decimal(entry->'request')>bill2_decimal(limits->'requestUsd')) THEN RAISE EXCEPTION 'BILL2_NOMINAL_BOUND_MISMATCH';END IF;
 END LOOP;
 price:=greatest(bill2_decimal(limits->'promptUsdPerMillion'),CASE WHEN limits ? 'cacheWriteUsdPerMillion' THEN bill2_decimal(limits->'cacheWriteUsdPerMillion') ELSE 0 END);
 u:=ceil(((t*price+o*bill2_decimal(limits->'completionUsdPerMillion'))/1000000)*1e12)/1e12+bill2_decimal(limits->'requestUsd');
 IF u<=0 OR u IS DISTINCT FROM bill2_decimal(p->'upperUsd') OR u>bill2_decimal(stable->'upperUsd')
 OR bill2_decimal(r.payload->'rules'->'billingUnit'->'creditsPerUsd') IS DISTINCT FROM r.credits_per_usd
 OR bill2_unit_multiplier(p->'billingUnit'->'multiplier')>r.multiplier THEN RAISE EXCEPTION 'BILL2_PAYG_BOUND_MISMATCH';END IF;
END $$;
CREATE OR REPLACE FUNCTION bill2_payg_claim(a uuid,rid uuid,seq integer,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;quarantine bigint;g numeric;h integer;q record;u numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 -- Window lock precedes every wallet/grant lock, as in v1.
 PERFORM runtime_billing_allowed(a,r.payload,r.id);PERFORM runtime_test_window_allowed(a,r.payload);
 IF NOT coalesce(bill2_scope_allowed(a,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=rid AND sequence=seq;
 IF c.id IS NOT NULL THEN
  IF c.payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);
 END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 IF octet_length(p::text)>65536 THEN RAISE EXCEPTION 'BILL2_CALL_TOO_LARGE';END IF;
 PERFORM bill2_payg_validate_quote(r,p);
 IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model'
  AND (x.budget_conflict OR x.metering_missing OR x.metering_exit)) THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) THEN RAISE EXCEPTION 'BILL2_CALL_PENDING';END IF;
 u:=bill2_decimal(p->'upperUsd');
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0)
 INTO n,used FROM bill2_calls WHERE run_id=rid;
 IF seq IS DISTINCT FROM n+1 OR n>=r.max_calls OR used+u>r.budget_usd THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 IF r.test_window_id IS NOT NULL THEN
  SELECT * INTO w FROM runtime_test_windows WHERE id=r.test_window_id FOR UPDATE;
  SELECT coalesce(sum(CASE WHEN x.contract_version='bill2.v2' THEN coalesce(calls.cost,0)
   WHEN x.closed AND NOT x.conflict AND x.provider_cost_usd IS NOT NULL THEN greatest(x.provider_cost_usd,coalesce(calls.cost,0))
   ELSE greatest(x.budget_usd,coalesce(calls.cost,0)) END),0),
   coalesce(sum(CASE WHEN x.contract_version='bill2.v2' OR x.closed THEN coalesce(calls.n,0) ELSE x.max_calls END),0)
  INTO used,used_calls FROM bill2_runs x LEFT JOIN LATERAL(
   SELECT count(*) n,sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END) cost
   FROM bill2_calls WHERE run_id=x.id) calls ON true WHERE x.test_window_id=w.id;
  IF used+u>w.max_cost_usd OR used_calls+1>w.max_calls THEN RAISE EXCEPTION 'RUNTIME_TEST_BUDGET_EXHAUSTED';END IF;
 END IF;
 SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;
 SELECT x INTO threshold FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg->'thresholds')='array' THEN cfg->'thresholds' ELSE '[]'::jsonb END) x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase';
 IF coalesce(cfg->>'version','')='' OR coalesce(threshold->>'credits','') !~ '^[1-9][0-9]{0,8}$'
 OR (SELECT count(*) FROM jsonb_array_elements(cfg->'thresholds') x WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase')<>1
 THEN RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';END IF;
 SELECT credits INTO avail FROM profiles WHERE id=a AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED';END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=a AND accounting_state<>'trusted') THEN
  RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';END IF;
 SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
 FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted'
 AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);
 avail:=greatest(avail-quarantine,0);
 IF avail<(threshold->>'credits')::int THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*bill2_unit_multiplier(p->'billingUnit'->'multiplier'));h:=least(g,avail)::int;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(rid,seq,p,p->>'provider',p->>'account',p->>'model',u) RETURNING * INTO c;
 SELECT * INTO q FROM atomic_pre_deduct(a,h,'BILL2 call reservation',c.id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_calls SET pre_deduct_id=q.pre_deduct_id,reserved_credits=h,available_credits=avail,
  start_threshold=(threshold->>'credits')::int,threshold_version=cfg->>'version' WHERE id=c.id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(a,-h,'adjustment','Call reservation','adjustment','bill2_reserve','ai_task',rid::text,
 'bill2:'||c.id||':reserve',q.balance_before,q.balance_after,rid,c.id,
 jsonb_build_object('contractVersion','bill2.v2','preDeductId',q.pre_deduct_id,'G',g::text,'H',h,'A',avail,'L',threshold->'credits','thresholdVersion',cfg->>'version'));
 UPDATE bill2_runs SET paused_reason=NULL,version=version+1 WHERE id=rid;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $$;
-- A confirmed whole-operation failure compensates only the original debit.
-- It never reuses the already-finalized pre-deduction refund entry point.
CREATE OR REPLACE FUNCTION bill2_payg_compensate(r bill2_runs,c bill2_calls) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE meta jsonb;grant_id uuid;period_part integer;other_part integer;restored integer;balance integer;g record;spend uuid;
BEGIN
 IF NOT r.closed OR r.outcome IS DISTINCT FROM 'confirmed_failure' OR c.settled_at IS NULL
  OR c.compensated_at IS NOT NULL OR c.charged_delta=0 THEN RETURN 0;END IF;
 SELECT metadata INTO meta FROM billing_history WHERE id=c.pre_deduct_id AND user_id=r.actor_id;
 SELECT id INTO spend FROM credit_transactions WHERE bill2_call_id=c.id AND reason_code='bill2_spend';
 IF spend IS NULL THEN RAISE EXCEPTION 'BILL2_COMPENSATION_SOURCE_MISSING';END IF;
 grant_id:=nullif(meta->>'chargedGrantId','')::uuid;
 period_part:=least(c.charged_delta,coalesce((meta->>'amountToPeriod')::int,0));
 other_part:=c.charged_delta-period_part;restored:=other_part;
 IF grant_id IS NOT NULL THEN
  SELECT cg.*,us.credit_release_terminated_at INTO g FROM subscription_credit_grants cg
   JOIN user_subscriptions us ON us.stripe_subscription_id=cg.stripe_subscription_id AND us.user_id=r.actor_id
   WHERE cg.id=grant_id AND cg.user_id=r.actor_id AND cg.grant_period_key=meta->>'chargedPeriodKey' FOR UPDATE OF cg;
  IF NOT FOUND OR g.accounting_state IS DISTINCT FROM 'trusted' OR g.status NOT IN ('granted','reversed') THEN
   RAISE EXCEPTION 'BILL2_COMPENSATION_GRANT_UNRESOLVED';END IF;
  IF g.status='granted' AND g.credit_release_terminated_at IS NULL AND g.period_end>clock_timestamp() THEN
   IF g.consumed_amount<period_part THEN RAISE EXCEPTION 'BILL2_COMPENSATION_SOURCE_CONSERVATION';END IF;
   UPDATE subscription_credit_grants SET consumed_amount=consumed_amount-period_part,updated_at=now() WHERE id=grant_id;
   restored:=restored+period_part;
  END IF;
 ELSIF period_part<>0 THEN RAISE EXCEPTION 'BILL2_COMPENSATION_SOURCE_MISSING';
 END IF;
 SELECT credits INTO balance FROM profiles WHERE id=r.actor_id FOR UPDATE;
 UPDATE profiles SET credits=credits+restored WHERE id=r.actor_id;
 meta:=jsonb_build_object('contractVersion','bill2.v2','runId',r.id,'callId',c.id,'originalPreDeductId',c.pre_deduct_id,
  'originalSpendId',spend,'requestedCompensation',c.charged_delta,'actualRestore',restored,
  'intercepted',c.charged_delta-restored,'reason','confirmed_delivery_failure');
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(r.actor_id,restored,'adjustment','Confirmed failure compensation','adjustment','bill2_compensation',
  'ai_task',r.id::text,'bill2:'||c.id||':compensation',balance,balance+restored,r.id,c.id,meta);
 INSERT INTO billing_history(user_id,operation_type,amount,reason,metadata)
 VALUES(r.actor_id,'refund',restored,'BILL2 confirmed failure compensation',meta);
 UPDATE bill2_calls SET compensated_at=clock_timestamp(),compensation_credits=restored WHERE id=c.id;
 UPDATE bill2_runs SET compensation_credits=compensation_credits+restored WHERE id=r.id;
 RETURN restored;
END $$;
CREATE OR REPLACE FUNCTION bill2_payg_finalize(a uuid,rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;rec record;usage jsonb;selected_usage jsonb;v numeric;n numeric;w numeric;delta numeric;
 bounded numeric;debit integer;cap numeric;bound numeric;before_balance integer;after_balance integer;restored integer;
 release_amount integer;q record;meta jsonb;spent uuid;source text;bad boolean;missing boolean;erasing boolean;pending boolean;
 prices jsonb;read_margin numeric;write_margin numeric;other_margin numeric;pt bigint;ct bigint;wt bigint;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 PERFORM id FROM bill2_calls WHERE run_id=rid ORDER BY id FOR UPDATE;
 PERFORM e.id FROM bill2_receipts e JOIN bill2_calls bc ON bc.id=e.call_id WHERE bc.run_id=rid ORDER BY e.id FOR UPDATE OF e;
 PERFORM id FROM profiles WHERE id=a FOR UPDATE;
 IF NOT bill2_payg_financial_binding(r) THEN RAISE EXCEPTION 'BILL2_FINANCIAL_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(a,rid);
 IF erasing AND NOT r.closed THEN
  PERFORM bill2_cancel(a,rid);SELECT * INTO r FROM bill2_runs WHERE id=rid;
 END IF;
 FOR c IN SELECT * FROM bill2_calls WHERE run_id=rid ORDER BY sequence LOOP
  n:=NULL;selected_usage:=NULL;bad:=false;source:='nominal';
  FOR rec IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
   AND payload->>'coverage'='request_total' AND payload->>'final'='true' ORDER BY created_at,id LOOP
   usage:=rec.payload->'usage';
   BEGIN
    v:=bill2_payg_nominal(c.payload->'payg'->'nominalPricing',usage);
    IF v IS NOT NULL THEN
     IF n IS NOT NULL AND (n<>v OR selected_usage->>'inputTokens' IS DISTINCT FROM usage->>'inputTokens'
      OR selected_usage->>'outputTokens' IS DISTINCT FROM usage->>'outputTokens'
      OR selected_usage->>'reasoningTokens' IS DISTINCT FROM usage->>'reasoningTokens') THEN bad:=true;END IF;
     n:=v;selected_usage:=usage;
    END IF;
   EXCEPTION WHEN OTHERS THEN bad:=true;
   END;
  END LOOP;
  -- Late data may reconstruct nominal value but can never rewrite a settled debit.
  IF c.settled_at IS NOT NULL THEN
   PERFORM bill2_payg_compensate(r,c);
   IF c.nominal_source='actual_fallback' AND n IS NOT NULL THEN UPDATE bill2_calls SET nominal_reconstructed_usd=n WHERE id=c.id;END IF;
   CONTINUE;
  END IF;
  IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=rid RETURNING * INTO r;EXIT;END IF;
  IF c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure') THEN
   IF c.dispatched_at IS NULL AND c.state<>'cancelled' THEN CONTINUE;END IF;
   n:=0;delta:=0;bounded:=0;debit:=0;cap:=0;bound:=0;source:=CASE WHEN c.dispatched_at IS NULL THEN 'not_dispatched' ELSE 'confirmed_failure' END;
  ELSE
   IF r.conflict OR c.selected_cost_usd IS NULL THEN EXIT;END IF;
   IF n IS NULL THEN
    IF c.recovery_attempts<3 AND clock_timestamp()<c.created_at+interval '24 hours'
     AND c.payload->>'lookupSupported'='true' AND c.provider_id IS NOT NULL THEN EXIT;END IF;
    n:=least(c.selected_cost_usd,c.upper_usd);source:='actual_fallback';
    UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;
   END IF;
   w:=r.weighted_nominal_usd;
   delta:=ceil((w+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   bounded:=ceil((w+least(n,c.upper_usd)*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   debit:=least(delta,c.reserved_credits)::int;cap:=greatest(bounded-c.reserved_credits,0);bound:=delta-debit-cap;
   UPDATE bill2_calls SET budget_conflict=budget_conflict OR n>upper_usd OR selected_cost_usd>upper_usd
    OR coalesce((selected_usage->>'inputTokens')::bigint>(payload->'payg'->>'promptTokensUpper')::bigint,false)
    OR coalesce((selected_usage->>'outputTokens')::bigint>(payload->>'outputLimit')::bigint,false),
    metering_exit=coalesce(payload->>'protocol'<>'fixture-cost-v1' AND
     ((selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'bytes')::numeric*4
      OR (selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'promptTokensUpper')::numeric*4),false),
    reconciliation_anomaly=CASE WHEN coalesce(selected_usage->>'cachedTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     AND coalesce(selected_usage->>'cacheCreationTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     THEN coalesce((selected_usage->>'cachedTokens')::bigint,0)+coalesce((selected_usage->>'cacheCreationTokens')::bigint,0)>coalesce((selected_usage->>'inputTokens')::bigint,0)
     ELSE true END
    WHERE id=c.id;
  END IF;
  read_margin:=NULL;write_margin:=NULL;other_margin:=NULL;
  IF source='nominal' AND selected_usage->>'inputTokens' IS NOT NULL THEN
   pt:=(selected_usage->>'inputTokens')::bigint;
   prices:=bill2_payg_prices(c.payload->'payg'->'nominalPricing',pt);
   ct:=CASE WHEN selected_usage->>'cachedTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cachedTokens')::bigint END;
   wt:=CASE WHEN selected_usage->>'cacheCreationTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cacheCreationTokens')::bigint END;
   IF NOT coalesce(ct+wt>pt,false) THEN
    IF ct<=pt AND prices ? 'cacheRead' THEN read_margin:=ct*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheRead'))/1000000;END IF;
    IF wt<=pt AND prices ? 'cacheWrite' THEN write_margin:=wt*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheWrite'))/1000000;END IF;
    other_margin:=n-c.selected_cost_usd-read_margin-write_margin;
   END IF;
  END IF;
  SELECT credits INTO before_balance FROM profiles WHERE id=a;
  meta:=jsonb_build_object('contractVersion','bill2.v2','runId',rid,'callId',c.id,'preDeductId',c.pre_deduct_id,
   'providerCostUsd',c.selected_cost_usd::text,'nominalCostUsd',n::text,'nominalSource',source,
   'theoreticalDelta',delta::text,'chargedDelta',debit,'platformCapCredits',cap::text,'platformBoundCredits',bound::text);
  IF c.dispatched_at IS NULL OR source='confirmed_failure' THEN
   SELECT * INTO q FROM bill2_legacy_refund(a,c.pre_deduct_id,'BILL2 undispatched call');restored:=q.refund_amount;
  ELSE
   SELECT * INTO q FROM bill2_legacy_settle(a,c.pre_deduct_id,debit,meta,NULL);restored:=q.difference;
  END IF;
  after_balance:=q.balance_after;release_amount:=restored+debit;
  IF restored<0 OR after_balance-before_balance<>restored OR release_amount>c.reserved_credits THEN RAISE EXCEPTION 'BILL2_SOURCE_CONSERVATION';END IF;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
   idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
  VALUES(a,release_amount,'adjustment','Call reservation release','adjustment','bill2_release','ai_task',rid::text,
   'bill2:'||c.id||':release',before_balance,before_balance::bigint+release_amount,rid,c.id,meta);
  IF c.dispatched_at IS NOT NULL AND source<>'confirmed_failure' THEN
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
   VALUES(a,-debit,'consumption','AI call consumption','spend','bill2_spend','ai_task',rid::text,
    'bill2:'||c.id||':spend',before_balance::bigint+release_amount,after_balance,rid,c.id,meta) RETURNING id INTO spent;
   UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=c.pre_deduct_id::text;
   INSERT INTO token_stats(bill2_run_id,bill2_call_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
   VALUES(rid,c.id,a,c.model,(selected_usage->>'inputTokens')::int,(selected_usage->>'outputTokens')::int,
    NULL,NULL,NULL,c.selected_cost_usd,debit,meta);
   INSERT INTO ai_usage_logs(bill2_run_id,bill2_call_id,user_id,request_id,model_id,status,metadata)
   VALUES(rid,c.id,a,c.id::text,c.model,'success',meta);
  END IF;
  UPDATE bill2_calls SET nominal_cost_usd=n,nominal_source=source,theoretical_delta=delta,charged_delta=debit,
   platform_absorbed_cap_credits=cap,platform_absorbed_bound_credits=bound,settled_at=clock_timestamp(),
   platform_margin_cache_read_usd=read_margin,platform_margin_cache_write_usd=write_margin,platform_margin_other_usd=other_margin WHERE id=c.id;
  UPDATE bill2_runs SET nominal_cost_usd=nominal_cost_usd+n,
   weighted_nominal_usd=weighted_nominal_usd+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'),
   theoretical_credits=theoretical_credits+delta,charged=coalesce(bill2_runs.charged,0)+debit,
   platform_absorbed_credits=platform_absorbed_credits+cap+bound,actual_restore=coalesce(actual_restore,0)+restored,
   version=version+1 WHERE id=rid RETURNING * INTO r;
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) INTO pending;
 UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)>0
  THEN NULL ELSE coalesce(sum(selected_cost_usd),0) END FROM bill2_calls WHERE run_id=rid),
  state=CASE WHEN closed AND NOT pending THEN CASE WHEN outcome<>'confirmed_failure' AND EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND dispatched_at IS NOT NULL) THEN 'settled' ELSE 'refunded' END
   WHEN pending THEN 'cost_pending' ELSE 'prepared' END,
  charged=coalesce(bill2_runs.charged,0) WHERE id=rid RETURNING * INTO r;
 IF r.theoretical_credits<>coalesce(r.charged,0)+r.platform_absorbed_credits THEN RAISE EXCEPTION 'BILL2_PAYG_CONSERVATION';END IF;
 RETURN bill2_erasure_view(r,erasing);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_prepare(p_actor_id uuid, p_request_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs; q record; b numeric; rate numeric; m numeric; reservation integer; new_id uuid:=gen_random_uuid(); fx record;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 -- Serialize missing-row admission before any profile/grant lock; no legacy lock takes this advisory lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 SELECT * INTO r FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
 IF r.id IS NOT NULL THEN IF r.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_REQUEST_CONFLICT';END IF;RETURN bill2_public(r);END IF;
 PERFORM bill2_execution_allowed(p_actor_id,p_payload);
 IF coalesce(p_payload->>'contractVersion','') NOT IN ('bill2.v1','bill2.v2') OR p_payload->>'sessionRef' IS NOT NULL
 OR p_payload->>'operation' IS NULL OR p_payload->>'operation' NOT IN ('question','research','organize','plan','work')
 OR (p_payload->'scope'->>'kind'='positioning_draft' AND p_payload->>'operation'='work')
 OR coalesce(p_payload->>'mode','') NOT IN ('isolated','staging_test') OR NOT(p_payload ? 'input')
 OR coalesce(p_payload->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR coalesce(length(p_payload->'rules'->>'version'),0)=0
 OR coalesce(length(p_payload->'rules'->>'quoteVersion'),0)=0 THEN RAISE EXCEPTION 'BILL2_INVALID_CONTRACT';END IF;
 IF NOT EXISTS(SELECT 1 FROM ai_models WHERE id=(p_payload->>'modelId')::uuid AND is_active='true') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 IF p_payload->>'revisionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_revisions sr JOIN skills s ON s.id=sr.skill_id WHERE sr.id=(p_payload->>'revisionId')::uuid AND s.status='published') THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
 b:=bill2_decimal(p_payload->'limits'->'costUsd');rate:=bill2_decimal(p_payload->'rules'->'creditsPerUsd');m:=bill2_decimal(p_payload->'rules'->'multiplier');
 reservation:=(p_payload->'limits'->>'credits')::integer;
 IF b<=0 OR b>100000 OR rate<=0 OR m<=0 OR reservation IS NULL OR (CASE WHEN p_payload->>'contractVersion'='bill2.v2' THEN reservation<>0 ELSE reservation<=0 OR ceil(b*rate*m)>reservation END)
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
 INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,contract_version,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline)
 VALUES(new_id,p_actor_id,p_request_id,p_payload->'scope',p_payload,p_payload->>'contractVersion',reservation,b,rate,m,(p_payload->'limits'->>'maxCalls')::integer,(p_payload->'limits'->>'deadline')::timestamptz);
 IF p_payload->>'contractVersion'='bill2.v2' THEN
  IF jsonb_typeof(p_payload->'rules'->'billingUnit') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_UNIT_REQUIRED';END IF;
  SELECT * INTO r FROM bill2_runs WHERE id=new_id;RETURN bill2_public(r);
 END IF;
 -- Internal UUID is independent of public/legacy request IDs. Never adopt an old pre-deduction.
 SELECT * INTO q FROM atomic_pre_deduct(p_actor_id,reservation,'BILL2 reservation',new_id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_runs SET pre_deduct_id=q.pre_deduct_id WHERE id=new_id RETURNING * INTO r;
 -- Profile lock serializes this actor; distinct timestamps preserve legacy timestamp-only pagination.
 INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,-reservation,'adjustment','Run reservation','adjustment','bill2_reserve','ai_task',new_id::text,'bill2:'||new_id||':reserve',q.balance_before,q.balance_after,new_id,jsonb_build_object('contractVersion','bill2.v1','preDeductId',q.pre_deduct_id));
 RETURN bill2_public(r);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;restricted boolean;BEGIN SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));
 -- A financial read for the original disabled/banned actor is not business admission.
 restricted:=NOT erasing AND EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id
  AND status IN ('disabled','banned') AND is_deleted='false')
  AND bill2_payg_financial_binding(r)
  AND EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=r.id
   AND (dispatched_at IS NOT NULL OR (dispatch_granted_at IS NOT NULL AND dispatch_revoked_at IS NOT NULL)));
 IF NOT erasing AND NOT restricted THEN PERFORM bill2_actor(p_actor_id);END IF;
 RETURN (CASE WHEN restricted THEN bill2_public(r)-'scope' ELSE bill2_erasure_view(r,erasing) END)||jsonb_build_object('executionId',(SELECT e.id FROM runtime_executions e
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=p_actor_id
  WHERE e.billing_run_id=r.id AND e.actor_id=p_actor_id AND r.session_ref=s.id), 'calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts,'preDeductId',pre_deduct_id,'chargedCredits',charged_delta) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $function$;

CREATE OR REPLACE FUNCTION public.bill2_close(p_actor_id uuid, p_run_id uuid, p_outcome text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;incoming jsonb;previous jsonb;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 -- Match financial writers: run -> calls/receipts -> profile. Confirmation holds only the profile.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls bc ON bc.id=x.call_id WHERE bc.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_actor_id FOR UPDATE;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));
 IF r.state IN ('settled','refunded') THEN RETURN bill2_erasure_view(r,erasing);END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('delivered','confirmed_failure','cancelled','unknown') THEN RAISE EXCEPTION 'BILL2_INVALID_OUTCOME';END IF;
 incoming:=CASE WHEN erasing THEN bill2_outcome_projection(p_result) ELSE p_result END;
 previous:=CASE WHEN erasing AND r.closed AND r.outcome<>'unknown' AND r.result_financial_projection_version IS NULL
   THEN bill2_outcome_projection(r.result) ELSE r.result END;
 IF r.closed AND r.outcome<>'unknown' THEN
  IF r.outcome IS DISTINCT FROM p_outcome OR previous IS DISTINCT FROM incoming THEN
   RAISE EXCEPTION 'BILL2_CLOSE_CONFLICT';
  END IF;
  RETURN bill2_erasure_view(r,erasing);
 END IF;
 IF p_outcome IN ('delivered','confirmed_failure') AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR coalesce(length(p_result->>'evidenceRef'),0)=0 OR coalesce(length(p_result->>'evidenceHash'),0)<>64
 OR p_result->>'kind' IS DISTINCT FROM CASE WHEN p_outcome='delivered' THEN 'usable_result' ELSE 'confirmed_delivery_failure' END) THEN RAISE EXCEPTION 'BILL2_OUTCOME_EVIDENCE_REQUIRED';END IF;
 IF octet_length(coalesce(p_result,'{}')::text)>262144 THEN RAISE EXCEPTION 'BILL2_RESULT_TOO_LARGE';END IF;
 UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid() WHERE run_id=r.id AND state='prepared';
 UPDATE bill2_runs SET closed=true,outcome=p_outcome,result=incoming,result_financial_projection_hash=CASE WHEN erasing AND incoming IS NOT NULL THEN encode(sha256(convert_to(incoming::text,'utf8')),'hex') END,
 result_financial_projection_version=CASE WHEN erasing AND incoming IS NOT NULL THEN 1 END,cancel_requested=cancel_requested OR p_outcome='cancelled',version=version+1,
 state=CASE WHEN p_outcome='unknown' THEN 'unknown' ELSE state END WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_erasure_view(r,erasing);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;other_id uuid;h text;raw_cost numeric;cost numeric;bad boolean:=false;prior jsonb;currency text;piece jsonb;parts numeric:=0;detail_total numeric;total_observation jsonb;erasing boolean;projection_hash text;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_NOT_DISPATCHED';END IF;
 -- Match financial writers: run -> calls/receipts -> profile. Confirmation holds only the profile.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls bc ON bc.id=x.call_id WHERE bc.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_actor_id FOR UPDATE;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));

 IF p_evidence->>'provider' IS DISTINCT FROM c.provider OR p_evidence->>'account' IS DISTINCT FROM c.account_namespace OR p_evidence->>'protocol' IS DISTINCT FROM c.payload->>'protocol'
 OR coalesce(p_evidence->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_evidence->'final') IS DISTINCT FROM 'boolean' OR coalesce(length(p_evidence->>'source'),0)=0 OR p_evidence->>'observedAt' IS NULL
 OR p_evidence->>'coverage' IS NULL OR p_evidence->>'coverage' NOT IN ('request_total','included_detail') THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
 h:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_erasure_view(r,erasing);END IF;
 IF erasing THEN
  -- Keep the conflict fact, never an arbitrary mismatching model string.
  IF p_evidence->>'model' IS DISTINCT FROM c.model THEN p_evidence:=jsonb_set(p_evidence,'{model}','null'::jsonb);END IF;
  p_evidence:=bill2_financial_projection(p_evidence);
  projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 END IF;
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
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing THEN 1 END,CASE WHEN erasing THEN clock_timestamp() END);
  UPDATE bill2_runs SET conflict=conflict OR bad,version=version+1,
   state=CASE WHEN state IN ('settled','refunded') OR c.selected_cost_usd IS NOT NULL THEN state
    WHEN coalesce(c.provider_id,p_evidence->>'providerId') IS NULL THEN 'unknown' ELSE 'cost_pending' END
   WHERE id=r.id RETURNING * INTO r;
  RETURN bill2_erasure_view(r,erasing);
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
 IF raw_cost IS NOT NULL AND parts>raw_cost AND r.contract_version='bill2.v1' THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='request_total' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR prior->>'model' IS DISTINCT FROM p_evidence->>'model' OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
  IF cost IS NOT NULL AND cost>c.upper_usd THEN
   IF r.contract_version='bill2.v1' THEN bad:=true;
   ELSE UPDATE bill2_calls SET budget_conflict=true WHERE id=c.id;END IF;END IF;
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
  IF r.contract_version='bill2.v1' AND (detail_total>bill2_decimal(total_observation->'cost') OR EXISTS(
   SELECT 1 FROM (SELECT payload FROM bill2_receipts WHERE call_id=c.id UNION ALL SELECT p_evidence) obs
   WHERE payload->>'coverage'='included_detail' AND payload->>'cost' IS NOT NULL AND payload->>'currency' IS DISTINCT FROM total_observation->>'currency')) THEN bad:=true;END IF;
 END LOOP;
 INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing THEN 1 END,CASE WHEN erasing THEN clock_timestamp() END);
 IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  IF p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND cost IS NOT NULL AND p_evidence->>'providerId' IS NOT NULL THEN
   UPDATE bill2_calls SET selected_cost_usd=cost,state='responded' WHERE id=c.id;
  ELSE UPDATE bill2_calls SET state=CASE WHEN selected_cost_usd IS NULL THEN 'unknown' ELSE state END WHERE id=c.id;END IF;
  IF r.state IN ('settled','refunded') THEN
   UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0 THEN coalesce(sum(selected_cost_usd),0) ELSE NULL END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE UPDATE bill2_runs SET state=CASE WHEN p_evidence->>'providerId' IS NULL THEN 'unknown' ELSE 'cost_pending' END,version=version+1 WHERE id=r.id RETURNING * INTO r;END IF;
 END IF;
 IF r.contract_version='bill2.v2' THEN
  PERFORM bill2_payg_finalize(p_actor_id,r.id);SELECT * INTO r FROM bill2_runs WHERE id=r.id;
 END IF;
 RETURN bill2_erasure_view(r,erasing);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;erasing boolean;terminal text;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(b.pre_deduct_id,b.id));
 IF NOT erasing AND e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  -- A winning financial outcome is authoritative even after execution content is gone.
  IF NOT erasing THEN
   IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
   ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  ELSIF b.state NOT IN ('settled','refunded') THEN
   IF NOT b.closed OR b.outcome IS NULL OR b.outcome='unknown' THEN
    IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
    ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
   END IF;
  END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   terminal:=CASE WHEN NOT erasing THEN CASE WHEN e.result IS NULL THEN 'cancelled' ELSE 'completed' END
     WHEN v->>'state'='settled' AND v->>'outcome'='delivered' THEN 'completed' ELSE 'cancelled' END;
   -- Already-erased terminal rows remain immutable; no redundant UPDATE or content write.
   IF e.state IS DISTINCT FROM terminal THEN
    UPDATE runtime_executions SET state=terminal WHERE id=e.id RETURNING * INTO e;
   END IF;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
   IF erasing THEN
    UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
   END IF;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 IF erasing THEN v:=(v-'scope')||'{"accountClosed":true}'::jsonb;END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_financial_batch(p_limit integer DEFAULT 20, p_profile_id uuid DEFAULT NULL::uuid, p_after_run_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_erasure_requests a
  JOIN profiles p ON p.id=a.profile_id WHERE p.id=p_profile_id
  AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
 END IF;
 WITH candidates AS MATERIALIZED (
  SELECT r.*, e.id execution_id,e.state execution_state,s.active_execution,
   a.confirmed_at,a.stage_updated_at,
   CASE
    WHEN r.conflict THEN 'BILLING_CONFLICT'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.provider_id IS NULL) THEN 'BILLING_NO_PROVIDER_ID'
    WHEN r.deadline+interval '24 hours'<clock_timestamp() THEN 'BILLING_EXPIRED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.recovery_attempts>=3) THEN 'BILLING_ATTEMPTS_EXHAUSTED'
    WHEN EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
     AND c.selected_cost_usd IS NULL AND c.payload->>'lookupSupported' IS DISTINCT FROM 'true')
     THEN 'BILLING_LOOKUP_UNSUPPORTED'
    ELSE 'BILLING_PENDING' END reason,
   (NOT r.closed OR e.state NOT IN ('completed','cancelled','cost_pending') OR s.active_execution=e.id
    OR (r.state IN ('settled','refunded') AND e.state NOT IN ('completed','cancelled'))
    OR (r.state NOT IN ('settled','refunded') AND NOT r.conflict AND
     (NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id
       AND c.dispatched_at IS NOT NULL AND c.selected_cost_usd IS NULL)
      OR (r.deadline+interval '24 hours'>=clock_timestamp() AND EXISTS(
       SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.dispatched_at IS NOT NULL
       AND c.selected_cost_usd IS NULL AND c.provider_id IS NOT NULL AND c.recovery_attempts<3
       AND c.payload->>'lookupSupported'='true'))))) needs_work
  FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN bill2_runs r ON r.actor_id=p.id
  JOIN runtime_executions e ON e.billing_run_id=r.id AND e.actor_id=p.id
  JOIN runtime_sessions s ON s.id=e.session_id AND s.actor_id=p.id AND r.session_ref=s.id
  WHERE p.status='deleted' AND p.is_deleted='true'
   AND bill2_erasure_closed(p.id,coalesce(r.pre_deduct_id,r.id))
   AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (r.state NOT IN ('settled','refunded') OR NOT r.closed
    OR e.state NOT IN ('completed','cancelled') OR s.active_execution=e.id)
 ), chosen AS (
  SELECT actor_id FROM candidates WHERE needs_work
  ORDER BY stage_updated_at,actor_id,id LIMIT 1
 ), page AS MATERIALIZED (
  SELECT c.* FROM candidates c JOIN chosen a USING(actor_id)
  WHERE c.needs_work AND (p_after_run_id IS NULL OR c.id>p_after_run_id)
  ORDER BY c.id LIMIT p_limit
 )
 SELECT jsonb_build_object(
  'selectedActorId',(SELECT actor_id FROM chosen),
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'actorId',actor_id,'executionId',execution_id,'runId',id,'sessionId',session_ref,
   'state',state,'executionState',execution_state,'closed',closed,'reason',reason,
   'confirmedAt',confirmed_at,
   'recoveryPolicy',jsonb_build_object('id',test_window_id,'expiresAt',deadline,
    'creditsPerUsd',credits_per_usd::text,'multiplier',multiplier::text,
    'callPolicies',(SELECT jsonb_agg(jsonb_build_object(
     'modelId',v->>'modelId','provider',v->>'provider','account',v->>'account','model',v->>'model',
     'protocol',v->>'protocol','upperUsd',v->>'upperUsd','inputLimit',v->'inputLimit',
     'outputLimit',v->'outputLimit','automaticRetry',v->'automaticRetry',
     'hiddenTools',v->'hiddenTools','lookupSupported',v->'lookupSupported'))
     FROM jsonb_array_elements(payload->'callPolicy') v))) ORDER BY id) FROM page),'[]'::jsonb),
  'nextRunId',CASE WHEN (SELECT count(*) FROM page)=p_limit
   THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END,
  'totalPending',(SELECT count(*) FROM candidates),
  'oldestPendingAt',(SELECT min(confirmed_at) FROM candidates),
  'reasons',coalesce((SELECT jsonb_object_agg(reason,n) FROM
    (SELECT reason,count(*) n FROM candidates GROUP BY reason) counts),'{}'::jsonb)) INTO result;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;erasing boolean;restricted boolean;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));
 -- Match the exact original call, including the retained one-shot proof after revocation.
 restricted:=NOT erasing AND EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id
  AND status IN ('disabled','banned') AND is_deleted='false')
  AND bill2_payg_financial_binding(r)
  AND EXISTS(SELECT 1 FROM bill2_calls WHERE id=p_call_id AND run_id=r.id
   AND token=p_token AND payload->>'requestHash'=p_request_hash
   AND (dispatched_at IS NOT NULL OR (dispatch_granted_at IS NOT NULL AND dispatch_revoked_at IS NOT NULL)));
 IF NOT erasing AND NOT restricted THEN PERFORM bill2_actor(p_actor_id);END IF;
 IF NOT erasing AND NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR p_token IS NULL OR c.token IS DISTINCT FROM p_token
  OR p_request_hash IS NULL OR c.payload->>'requestHash' IS DISTINCT FROM p_request_hash
  OR c.provider<>'openrouter' OR c.payload->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1'
 THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- Retain the original token for exact idempotent readback. Cancelled state
 -- permanently prevents rotate/dispatch; bill2_record rejects NULL dispatch.
 IF c.dispatch_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('revoked',true,'eligible',false);END IF;
 eligible:=NOT r.conflict AND c.state='dispatched' AND c.dispatched_at IS NOT NULL
  AND c.provider_id IS NULL AND c.selected_cost_usd IS NULL
  AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id);
 IF p_inspect THEN RETURN jsonb_build_object('revoked',false,'eligible',eligible);END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- The dispatch timestamp represented a permission grant, not observed HTTP.
 -- Preserve it before clearing the existing possible-dispatch accounting flag.
 UPDATE bill2_calls SET dispatch_granted_at=dispatched_at,dispatch_revoked_at=clock_timestamp(),dispatched_at=NULL,state='cancelled' WHERE id=c.id;
 PERFORM bill2_cancel(p_actor_id,r.id);
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $function$;

CREATE OR REPLACE FUNCTION public.atomic_refund(p_user_id uuid, p_pre_deduct_id uuid, p_reason text DEFAULT 'AI 调用失败退费'::text)
 RETURNS TABLE(refund_amount integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_refund(p_user_id,p_pre_deduct_id,p_reason);END $function$;

CREATE OR REPLACE FUNCTION public.atomic_settle(p_user_id uuid, p_pre_deduct_id uuid, p_actual_credits integer, p_usage jsonb DEFAULT '{}'::jsonb, p_response jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(actual_credits integer, difference integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_settle(p_user_id,p_pre_deduct_id,p_actual_credits,p_usage,p_response);END $function$;

CREATE OR REPLACE FUNCTION public.atomic_abort_settle(p_user_id uuid, p_pre_deduct_id uuid, p_consumed_credits integer, p_consumed_tokens jsonb, p_model_id text, p_reason text DEFAULT '用户中断'::text)
 RETURNS TABLE(consumed_credits integer, refunded_credits integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
RETURN QUERY SELECT * FROM bill2_legacy_abort_settle(p_user_id,p_pre_deduct_id,p_consumed_credits,p_consumed_tokens,p_model_id,p_reason);END $function$;

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_failure(p_user_id uuid, p_model_used text, p_reason text, p_pre_deduct_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_request_id text DEFAULT NULL::text, p_input_length integer DEFAULT NULL::integer, p_latency_ms integer DEFAULT NULL::integer, p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_usage_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(refund_amount integer, balance_after integer, transaction_id uuid, refund_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_failure(p_user_id,p_model_used,p_reason,p_pre_deduct_id,p_conversation_id,p_request_id,p_input_length,p_latency_ms,p_ip_address,p_user_agent,p_usage_metadata);
END $function$;

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_abort(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_partial_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_consumed_credits integer, p_pre_deduct_id uuid, p_usage jsonb DEFAULT '{}'::jsonb, p_token_metadata jsonb DEFAULT '{}'::jsonb, p_usage_metadata jsonb DEFAULT '{}'::jsonb, p_request_id text DEFAULT NULL::text, p_input_length integer DEFAULT NULL::integer, p_latency_ms integer DEFAULT NULL::integer, p_search_count integer DEFAULT 0, p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
 RETURNS TABLE(user_message_id uuid, assistant_message_id uuid, transaction_id uuid, abort_id uuid, balance_after integer, refunded_credits integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_abort(p_user_id,p_conversation_id,p_user_message,p_partial_assistant_message,p_model_used,p_total_cost_usd,p_consumed_credits,p_pre_deduct_id,p_usage,p_token_metadata,p_usage_metadata,p_request_id,p_input_length,p_latency_ms,p_search_count,p_ip_address,p_user_agent);
END $function$;

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_success(p_user_id uuid, p_conversation_id uuid, p_user_message text, p_assistant_message text, p_model_used text, p_total_cost_usd numeric, p_total_credits integer, p_pre_deduct_id uuid DEFAULT NULL::uuid, p_usage jsonb DEFAULT '{}'::jsonb, p_token_metadata jsonb DEFAULT '{}'::jsonb, p_usage_metadata jsonb DEFAULT '{}'::jsonb, p_request_id text DEFAULT NULL::text, p_input_length integer DEFAULT NULL::integer, p_latency_ms integer DEFAULT NULL::integer, p_search_count integer DEFAULT 0, p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
 RETURNS TABLE(user_message_id uuid, assistant_message_id uuid, transaction_id uuid, settle_id uuid, balance_after integer, refunded_credits integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE pre_deduct_id=p_pre_deduct_id) OR EXISTS(SELECT 1 FROM bill2_calls WHERE pre_deduct_id=p_pre_deduct_id) THEN RAISE EXCEPTION 'BILL2_LEGACY_FINALIZER_DENIED';END IF;
 RETURN QUERY SELECT * FROM bill2_legacy_finalize_success(p_user_id,p_conversation_id,p_user_message,p_assistant_message,p_model_used,p_total_cost_usd,p_total_credits,p_pre_deduct_id,p_usage,p_token_metadata,p_usage_metadata,p_request_id,p_input_length,p_latency_ms,p_search_count,p_ip_address,p_user_agent);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_public(r bill2_runs)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('id',r.id,'scope',r.scope,'state',r.state,'closed',r.closed,'cancelRequested',r.cancel_requested,
 'outcome',r.outcome,'reservedCredits',r.reserved,'chargedCredits',r.charged,'actualRestoredCredits',r.actual_restore,
 'preDeductId',r.pre_deduct_id,'providerCostUsd',r.provider_cost_usd::text,'conflict',r.conflict,'version',r.version,'contractVersion',r.contract_version)||CASE WHEN r.contract_version='bill2.v2' THEN jsonb_build_object('nominalCostUsd',r.nominal_cost_usd::text,'theoreticalCredits',r.theoretical_credits::text,'platformAbsorbedCredits',r.platform_absorbed_credits::text,'pausedReason',r.paused_reason,'compensationCredits',r.compensation_credits,'netChargedCredits',coalesce(r.charged,0)-r.compensation_credits) ELSE '{}'::jsonb END;
$function$;

CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid, p_run_id uuid, p_sequence integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;weighted boolean;wused numeric;m_call numeric;
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id AND contract_version='bill2.v2') THEN RETURN bill2_payg_claim(p_actor_id,p_run_id,p_sequence,p_payload); END IF;
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
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id AND contract_version='bill2.v2') THEN RETURN bill2_payg_finalize(p_actor_id,p_run_id); END IF;
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

CREATE OR REPLACE FUNCTION public.bill2_financial_projection(e jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb := '{}'; k text; piece jsonb; details jsonb := '[]'; usage jsonb := '{}';
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION'; END IF;
  FOREACH k IN ARRAY ARRAY['provider','account','protocol','model','providerId','expectedProviderId',
    'source','sourceHash','observedAt','coverage','detailId','currency','cost','evidenceKind'] LOOP
    IF e ? k THEN
      IF jsonb_typeof(e->k) NOT IN ('string','null') THEN RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION'; END IF;
      v := v || jsonb_build_object(k,e->k);
    END IF;
  END LOOP;
  IF e->>'source' NOT IN ('response','lookup','transport_unknown')
    OR coalesce(e->>'sourceHash','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(e->'final') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
  END IF;
  IF coalesce(e->>'currency','') !~ '^[A-Z]{3}$'
    OR (e->>'evidenceKind' IS NOT NULL AND e->>'evidenceKind' <> 'transport_observation') THEN
    RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
  END IF;
  FOREACH k IN ARRAY ARRAY['providerId','expectedProviderId','detailId'] LOOP
    IF e->>k IS NOT NULL AND (length(e->>k) NOT BETWEEN 1 AND 256 OR e->>k !~ '^[A-Za-z0-9._:-]+$') THEN
      RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
    END IF;
  END LOOP;
  -- Reject non-timestamps, and store the typed timestamp rather than arbitrary source text.
  v := v || jsonb_build_object('observedAt',(e->>'observedAt')::timestamptz,'final',e->'final');
  IF e->>'cost' IS NOT NULL THEN PERFORM bill2_decimal(e->'cost'); END IF;
  IF jsonb_typeof(coalesce(e->'includedDetails','[]')) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'BILL2_INVALID_COVERAGE';
  END IF;
  FOR piece IN SELECT value FROM jsonb_array_elements(coalesce(e->'includedDetails','[]')) LOOP
    PERFORM bill2_decimal(piece->'cost');
    IF jsonb_typeof(piece->'currency') IS DISTINCT FROM 'string' OR piece->>'currency' !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
    END IF;
    details := details || jsonb_build_array(jsonb_build_object('cost',piece->'cost','currency',piece->'currency'));
  END LOOP;
  FOREACH k IN ARRAY ARRAY['inputTokens','outputTokens','cachedTokens','cacheCreationTokens','webSearchCount','reasoningTokens'] LOOP
    IF jsonb_typeof(e->'usage'->k) IN ('string','number') AND e->'usage'->>k ~ '^(0|[1-9][0-9]{0,9})$' THEN
      usage := usage || jsonb_build_object(k,e->'usage'->k);
    END IF;
  END LOOP;
  v := v || jsonb_build_object('includedDetails',details,'usage',usage);
  -- Only presence affects the original conflict rule; free-form diagnostics are never retained.
  IF e->>'rejectedReason' IS NOT NULL THEN v := v || '{"rejectedReason":"erasure_rejected"}'::jsonb; END IF;
  IF e->>'costIssue' IN ('missing_cost','invalid_cost') THEN v := v || jsonb_build_object('costIssue',e->>'costIssue'); END IF;
  RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_pending_calls(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 RETURN (SELECT coalesce(jsonb_agg(id ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=p_run_id AND dispatched_at IS NOT NULL AND (selected_cost_usd IS NULL OR (pre_deduct_id IS NOT NULL AND settled_at IS NULL)));
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_recovery_claim(p_actor_id uuid, p_run_id uuid, p_call_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL OR c.provider_id IS NULL OR (c.selected_cost_usd IS NOT NULL AND (r.contract_version='bill2.v1' OR c.settled_at IS NOT NULL)) OR c.recovery_attempts>=3
 OR clock_timestamp()>(CASE WHEN r.contract_version='bill2.v2' THEN c.created_at+interval '24 hours' ELSE r.deadline+interval '24 hours' END) OR c.payload->>'lookupSupported' IS DISTINCT FROM 'true' OR r.conflict THEN RETURN NULL;END IF;
 UPDATE bill2_calls SET recovery_attempts=recovery_attempts+1 WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'providerId',c.provider_id,'provider',c.provider,'account',c.account_namespace,'model',c.model,'protocol',c.payload->>'protocol');
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_rotate boolean DEFAULT false, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_DENIED';END IF;
 IF r.contract_version='bill2.v2' AND (c.pre_deduct_id IS NULL OR c.settled_at IS NOT NULL OR EXISTS(SELECT 1 FROM bill2_calls x WHERE x.run_id=r.id AND (x.budget_conflict OR x.metering_missing OR x.metering_exit))) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline OR c.state<>'prepared' OR (NOT p_rotate AND c.token IS DISTINCT FROM p_token) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 -- Final permission check serializes a concurrent account suspension before any HTTP grant.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF p_rotate THEN IF p_payload IS DISTINCT FROM c.payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF; UPDATE bill2_calls SET token=gen_random_uuid() WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('dispatch',false,'dispatchToken',c.token);END IF;
 UPDATE bill2_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=c.id;
 UPDATE bill2_runs SET state='dispatched',version=version+1 WHERE id=r.id;
 RETURN jsonb_build_object('dispatch',true);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_test_budget_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
 IF NEW.contract_version='bill2.v2' THEN NEW.test_window_id:=w.id;RETURN NEW;END IF;
 SELECT coalesce(sum(CASE WHEN r.contract_version='bill2.v2' THEN coalesce(c.observed_cost,0) WHEN r.closed AND NOT r.conflict AND r.provider_cost_usd IS NOT NULL
   THEN greatest(r.provider_cost_usd,coalesce(c.observed_cost,0))
   ELSE greatest(r.budget_usd,coalesce(c.observed_cost,0)) END),0),
  coalesce(sum(CASE WHEN r.contract_version='bill2.v2' OR r.closed THEN coalesce(c.n,0) ELSE r.max_calls END),0)
 INTO used,calls FROM bill2_runs r
 LEFT JOIN LATERAL (SELECT count(*) n,sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END) observed_cost FROM bill2_calls WHERE run_id=r.id) c ON true
 WHERE r.test_window_id=w.id;
 IF used+NEW.budget_usd>w.max_cost_usd OR calls+NEW.max_calls>w.max_calls
 THEN RAISE EXCEPTION 'RUNTIME_TEST_BUDGET_EXHAUSTED';END IF;
 NEW.test_window_id:=w.id;RETURN NEW;
END $function$;

DROP FUNCTION bill2_admin_call_report(timestamptz,timestamptz,integer);
CREATE OR REPLACE FUNCTION public.bill2_admin_call_report(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer)
 RETURNS TABLE(call_id uuid, run_id uuid, call_sequence integer, created_at timestamp with time zone, provider text, model text, call_state text, selected_cost_usd text, run_state text, run_outcome text, credits_per_usd text, run_multiplier text, run_charged integer, run_actual_restore integer, run_call_count integer, call_multiplier text, multiplier_source text, purpose text,contract_version text,settled_at timestamptz,nominal_cost_usd text,nominal_source text,charged_delta integer,theoretical_delta text,platform_absorbed_cap_credits text,platform_absorbed_bound_credits text,platform_absorbed_cap_usd text,platform_absorbed_bound_usd text,platform_margin_usd text,platform_margin_cache_read_usd text,platform_margin_cache_write_usd text,platform_margin_other_usd text,compensation_credits integer,compensated_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.run_id, c.sequence, c.created_at,
         c.provider, c.model, c.state, c.selected_cost_usd::text,
         r.state, r.outcome, r.credits_per_usd::text, r.multiplier::text,
         r.charged, r.actual_restore, (SELECT count(*)::integer FROM bill2_calls x WHERE x.run_id = r.id),
         c.payload #>> '{billingUnit,multiplier}', c.payload #>> '{billingUnit,source}',
         coalesce(c.payload->>'phase',r.payload #>> '{purposeBudget,purpose}'),r.contract_version,c.settled_at,c.nominal_cost_usd::text,c.nominal_source,c.charged_delta,c.theoretical_delta::text,c.platform_absorbed_cap_credits::text,c.platform_absorbed_bound_credits::text,CASE WHEN r.contract_version='bill2.v2' THEN (c.platform_absorbed_cap_credits/(r.credits_per_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')))::text END,CASE WHEN r.contract_version='bill2.v2' THEN (c.platform_absorbed_bound_credits/(r.credits_per_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')))::text END,(c.nominal_cost_usd-c.selected_cost_usd)::text,c.platform_margin_cache_read_usd::text,c.platform_margin_cache_write_usd::text,c.platform_margin_other_usd::text,c.compensation_credits,c.compensated_at
  FROM bill2_calls c
  JOIN bill2_runs r ON r.id = c.run_id
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND c.created_at >= p_from AND c.created_at < p_to
  ORDER BY c.created_at, c.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 1), 1), 5000)
$function$
;
REVOKE ALL ON FUNCTION bill2_admin_call_report(timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION bill2_admin_call_report(timestamptz,timestamptz,integer) TO service_role;
CREATE OR REPLACE FUNCTION bill2_payg_absorb_report(p_from timestamptz,p_to timestamptz)
RETURNS TABLE(model text,utc_date text,credits_per_usd text,call_multiplier text,platform_cap_credits text,platform_bound_credits text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.model,to_char(c.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD'),r.credits_per_usd::text,
 c.payload->'billingUnit'->>'multiplier',sum(c.platform_absorbed_cap_credits)::text,sum(c.platform_absorbed_bound_credits)::text
 FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
 WHERE r.contract_version='bill2.v2' AND c.settled_at>=p_from AND c.settled_at<p_to
 GROUP BY c.model,to_char(c.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD'),r.credits_per_usd,c.payload->'billingUnit'->>'multiplier'
$$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure sig,proname FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND (proname LIKE 'bill2_payg_%' OR proname='bill2_erasure_closed') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
 IF f.proname='bill2_payg_absorb_report' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END IF;
 END LOOP;
END $$;

COMMIT;
