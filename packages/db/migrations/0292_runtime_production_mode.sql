-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RUNTIME-PROD (docs/launch/tasks/RUNTIME-PROD.md): BILL2 accepts mode='production' on a database marked as the
-- production database. There is no test window: the run freezes quotes the server derived from the stored price
-- snapshot, and SQL checks the host, the enabled production profile of every model route, the credential
-- fingerprint, the configured q/m and (at prepare) the stored price snapshot. Production is BILL2 v2 only.
--
-- Production database = system_settings.runtime_environment is the JSON string "production" (written only by the
-- approved release SQL; the admin settings writer refuses this key) AND no enabled test window exists.
-- staging_test is refused on such a database, production is refused everywhere else, so neither configuration
-- can run on the other's database.
--
-- Existing functions are patched at exact anchors (a missing anchor aborts the migration, a rerun is a no-op).
-- No data change. Rollback: switch production off (runtime_payg_production {"enabled":false}) and leave the
-- functions; staging and isolated paths are unchanged by this file.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_production_database() RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM system_settings WHERE key='runtime_environment' AND value='"production"'::jsonb)
  AND NOT EXISTS(SELECT 1 FROM runtime_test_windows WHERE enabled)
$$;

-- The production counterpart of runtime_test_window_allowed. p_prepare adds the checks that hold only when the run
-- is created (profile version, configured q/m, stored price snapshot); later claims and dispatches recheck the host,
-- the switch, each route's profile and the credential, so revoking a route or rotating a key stops new calls.
CREATE OR REPLACE FUNCTION public.runtime_production_allowed(a uuid,p jsonb,p_prepare boolean) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb;entry jsonb;q jsonb;dm jsonb;m ai_models;expected numeric;
BEGIN
 IF NOT runtime_production_database() OR p ? 'testWindowId' OR p->>'contractVersion' IS DISTINCT FROM 'bill2.v2'
 OR p->'input'->>'version' IS DISTINCT FROM 'runtime.v1' OR p->'input'->>'network' IS DISTINCT FROM 'deny'
 OR coalesce(p->'input'->'tools','[]'::jsonb) @> '["search"]'::jsonb
 OR p->'rules'->>'version' IS DISTINCT FROM 'runtime-production-v1'
 OR jsonb_typeof(p->'callPolicy') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 SELECT value INTO cfg FROM system_settings WHERE key='runtime_payg_production';
 IF jsonb_typeof(cfg)='string' THEN cfg:=(cfg#>>'{}')::jsonb;END IF;
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg->'enabled' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(cfg->'profiles') IS DISTINCT FROM 'array'
 OR (p_prepare AND cfg->>'policyVersion' IS DISTINCT FROM p->'rules'->>'quoteVersion')
 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 IF p_prepare THEN
  SELECT value INTO q FROM system_settings WHERE key='billing_credits_per_usd';
  SELECT value INTO dm FROM system_settings WHERE key='billing_token_price_multiplier';
  -- Configured rows only: production never bills with the code fallback.
  IF q IS NULL OR dm IS NULL OR (q#>>'{}')::numeric IS DISTINCT FROM bill2_decimal(p->'rules'->'creditsPerUsd')
  THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'callPolicy') LOOP
  SELECT * INTO m FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND is_active='true';
  IF m.id IS NULL OR entry->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1' OR entry->>'provider' IS DISTINCT FROM 'openrouter'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'profiles') prof WHERE prof->>'model'=entry->>'model'
    AND prof->>'endpointTag'=entry->'providerLimits'->>'providerSlug')
  OR coalesce(btrim(m.api_key,E' \t\r\n'),'')=''
  OR entry->>'account' IS DISTINCT FROM 'openrouter-key:'||encode(sha256(convert_to(btrim(m.api_key,E' \t\r\n'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_MODEL_DENIED' USING ERRCODE='42501';END IF;
  IF p_prepare THEN
   expected:=coalesce(m.price_multiplier,(dm#>>'{}')::numeric);
   IF bill2_unit_multiplier(entry->'multiplier') IS DISTINCT FROM expected
   OR entry->'payg'->>'pricingHash' IS DISTINCT FROM m.config->'pricing'->>'pricingHash'
   OR entry->'payg'->>'policyId' IS DISTINCT FROM p->'rules'->>'quoteVersion'
   THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_MODEL_DENIED' USING ERRCODE='42501';END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.runtime_production_database() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.runtime_production_allowed(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Host check for new work and maintenance reads on production (service role only).
CREATE OR REPLACE FUNCTION public.runtime_production_access(p_actor_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT runtime_production_database() THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 PERFORM bill2_actor(p_actor_id);
 RETURN true;
END $$;

-- The original run's frozen policy, for receipt lookups and resume of a production execution.
CREATE OR REPLACE FUNCTION public.runtime_production_recovery_policy(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b bill2_runs;
BEGIN
 IF NOT runtime_production_database() THEN RAISE EXCEPTION 'RUNTIME_TEST_RECOVERY_DENIED' USING ERRCODE='42501';END IF;
 SELECT r.* INTO b FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
 WHERE e.id=p_execution_id AND e.actor_id=p_actor_id AND r.actor_id=p_actor_id
 AND r.session_ref=e.session_id AND r.test_window_id IS NULL AND r.payload->>'mode'='production';
 IF b.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_TEST_RECOVERY_DENIED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('mode','production','id',b.payload->'rules'->>'quoteVersion','callPolicies',b.payload->'callPolicy',
  'creditsPerUsd',b.payload->'rules'->>'creditsPerUsd','multiplier',b.payload->'rules'->>'multiplier','expiresAt',b.deadline);
END $$;
REVOKE ALL ON FUNCTION public.runtime_production_access(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.runtime_production_recovery_policy(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_production_access(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.runtime_production_recovery_policy(uuid,uuid) TO service_role;

DO $runtime_production$
DECLARE source text; patch record; hits integer;
BEGIN
 FOR patch IN SELECT * FROM (VALUES
  ('public.bill2_prepare(uuid,uuid,jsonb)',
   $o$NOT IN ('isolated','staging_test') OR NOT(p_payload ? 'input')$o$,
   $n$NOT IN ('isolated','staging_test','production') OR NOT(p_payload ? 'input')$n$),
  -- Every claim, dispatch and execution step already calls this gate; production gets its own branch, and a
  -- staging window is refused on the production database.
  ('public.runtime_test_window_allowed(uuid,jsonb)',
   $o$ IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF p ? 'testWindowId' THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED';END IF;
  RETURN;
 END IF;
$o$,
   $n$ IF p->>'mode'='production' THEN PERFORM runtime_production_allowed(a,p,false);RETURN;END IF;
 IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF p ? 'testWindowId' THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED';END IF;
  RETURN;
 END IF;
 IF runtime_production_database() THEN RAISE EXCEPTION 'RUNTIME_TEST_WINDOW_DENIED' USING ERRCODE='42501';END IF;
$n$),
  -- Run creation: the prepare-only production checks (version, q/m, price snapshot).
  ('public.runtime_test_budget_guard()',
   $o$ IF NEW.payload->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF NEW.test_window_id IS NOT NULL$o$,
   $n$ IF NEW.payload->>'mode'='production' THEN PERFORM runtime_production_allowed(NEW.actor_id,NEW.payload,true);END IF;
 IF NEW.payload->>'mode' IS DISTINCT FROM 'staging_test' THEN
  IF NEW.test_window_id IS NOT NULL$n$),
  -- Content permissions do not depend on the switch (as for staging windows); production calls are real OpenRouter calls.
  ('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)',
   $o$ IF p->>'mode' IS DISTINCT FROM 'staging_test' THEN PERFORM runtime_test_window_allowed(a,p);END IF;$o$,
   $n$ IF coalesce(p->>'mode','') NOT IN ('staging_test','production') THEN PERFORM runtime_test_window_allowed(a,p);END IF;$n$),
  ('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)',
   $o$(p->>'mode'='staging_test' AND entry->>'provider'='openrouter'$o$,
   $n$(p->>'mode' IN ('staging_test','production') AND entry->>'provider'='openrouter'$n$),
  ('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)',
   $o$(CASE WHEN p->>'mode'='staging_test' THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END)$o$,
   $n$(CASE WHEN p->>'mode' IN ('staging_test','production') THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END)$n$)
 ) AS t(signature,old_text,new_text) LOOP
  source:=pg_get_functiondef(patch.signature::regprocedure);
  IF position(patch.new_text IN source)>0 THEN CONTINUE; END IF;
  hits:=(length(source)-length(replace(source,patch.old_text,'')))/length(patch.old_text);
  IF hits<>1 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_PATCH_MISSING: %',patch.signature; END IF;
  EXECUTE replace(source,patch.old_text,patch.new_text);
 END LOOP;
END $runtime_production$;

COMMIT;
