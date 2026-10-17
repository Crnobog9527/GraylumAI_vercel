-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RUNTIME-PROD research tools (docs/launch/tasks/RUNTIME-PROD.md section 6): production runs may carry research tool
-- routes (protocol research-tool-v1, 0255). There is no test window, so a route is approved by the settings the admin
-- already maintains: research_tools_config (the master switch, and the vendor switch that needs an attested platform
-- hard cap, Owner 2026-10-07) and billing_provider_prices (every charge-bearing field of the frozen price must equal the
-- current entry: price, units, currency, usage unit, exchange rate and validity; and the
-- route multiplier must equal its override or the configured default m). Claims recheck the vendor switch.
--
-- PUBLISH-MONITOR 4b (0289, Owner 2026-10-17): a tool-only publish monitor run (v2, input.publishMonitor object, the
-- fixed placeholder model id, every entry a tool route) has no model and so needs no production model profile; it
-- still needs the production database, the production switch, the vendor switch and an exact price. The recognition is spelled out here so
-- this file does not depend on the order in which 0289 and 0292 are applied.
--
-- Replaces runtime_production_allowed (0291) only. No data change. Rollback: switch the vendors off in
-- research_tools_config; the 0291 definition can be restored from that file.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_production_allowed(a uuid,p jsonb,p_prepare boolean) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb;rc jsonb;prices jsonb;pe jsonb;entry jsonb;q jsonb;dm jsonb;m ai_models;expected numeric;route text;
 tool_only boolean;
BEGIN
 IF NOT runtime_production_database() OR p ? 'testWindowId' OR p->>'contractVersion' IS DISTINCT FROM 'bill2.v2'
 OR p->'input'->>'version' IS DISTINCT FROM 'runtime.v1' OR p->'input'->>'network' IS DISTINCT FROM 'deny'
 OR coalesce(p->'input'->'tools','[]'::jsonb) @> '["search"]'::jsonb
 OR p->'rules'->>'version' IS DISTINCT FROM 'runtime-production-v1'
 OR jsonb_typeof(p->'callPolicy') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'callPolicy') NOT BETWEEN 1 AND 32
 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 -- coalesce: a missing marker must read as false, never NULL (NOT NULL would skip the model-profile checks).
 tool_only:=coalesce(jsonb_typeof(p->'input'->'publishMonitor')='object'
  AND p->>'modelId'=bill2_tool_model_id('publish-monitor:read-run')::text
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'callPolicy') x WHERE x->>'protocol' IS DISTINCT FROM 'research-tool-v1'),false);
 SELECT value INTO cfg FROM system_settings WHERE key='runtime_payg_production';
 IF jsonb_typeof(cfg)='string' THEN cfg:=(cfg#>>'{}')::jsonb;END IF;
 -- The production switch (enabled:false) stops every production run, monitor runs included (#1086 review);
 -- only the model-profile checks are skipped for a tool-only monitor run.
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg->'enabled' IS DISTINCT FROM 'true'::jsonb
 OR (NOT tool_only AND (jsonb_typeof(cfg->'profiles') IS DISTINCT FROM 'array'
  OR (p_prepare AND cfg->>'policyVersion' IS DISTINCT FROM p->'rules'->>'quoteVersion')))
 THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 SELECT value INTO dm FROM system_settings WHERE key='billing_token_price_multiplier';
 IF p_prepare THEN
  SELECT value INTO q FROM system_settings WHERE key='billing_credits_per_usd';
  -- Configured rows only: production never bills with the code fallback.
  IF q IS NULL OR dm IS NULL OR (q#>>'{}')::numeric IS DISTINCT FROM bill2_decimal(p->'rules'->'creditsPerUsd')
  THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 SELECT value INTO rc FROM system_settings WHERE key='research_tools_config';
 IF jsonb_typeof(rc)='string' THEN rc:=(rc#>>'{}')::jsonb;END IF;
 SELECT value INTO prices FROM system_settings WHERE key='billing_provider_prices';
 IF jsonb_typeof(prices)='string' THEN prices:=(prices#>>'{}')::jsonb;END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'callPolicy') LOOP
  IF entry->>'protocol'='research-tool-v1' THEN
   IF coalesce(entry->>'provider','') NOT IN ('tikhub','parallel','firecrawl')
   OR entry->>'model' NOT LIKE (entry->>'provider')||':%'
   OR entry->>'modelId' IS DISTINCT FROM bill2_tool_model_id(entry->>'model')::text
   OR rc->'vendors'->(entry->>'provider')->'enabled' IS DISTINCT FROM 'true'::jsonb
   OR (NOT tool_only AND rc->'enabled' IS DISTINCT FROM 'true'::jsonb)
   THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_MODEL_DENIED' USING ERRCODE='42501';END IF;
   IF p_prepare THEN
    route:=substr(entry->>'model',length(entry->>'provider')+2);
    -- billingProviderPrices.resolveProviderPrice: the exact route, else the one provider-wide entry for unlisted routes.
    SELECT x INTO pe FROM jsonb_array_elements(coalesce(prices->'entries','[]'::jsonb)) x
     WHERE x->>'provider'=entry->>'provider' AND x->>'route'=route;
    IF pe IS NULL THEN
     SELECT x INTO pe FROM jsonb_array_elements(coalesce(prices->'entries','[]'::jsonb)) x
      WHERE x->>'provider'=entry->>'provider' AND x->'route'='null'::jsonb AND x->'appliesToUnlistedRoutes'='true'::jsonb;
    END IF;
    expected:=coalesce((pe->>'priceMultiplier')::numeric,(dm#>>'{}')::numeric);
    IF pe IS NULL OR dm IS NULL
    OR (entry->'toolPricing'->>'price')::numeric IS DISTINCT FROM (pe->>'price')::numeric
    OR entry->'toolPricing'->>'unitsPerPrice' IS DISTINCT FROM pe->>'unitsPerPrice'
    OR entry->'toolPricing'->>'currency' IS DISTINCT FROM pe->>'currency'
    -- Every charge-bearing field of toolBilling.toolCallPolicy (#1086 review): unit, exchange rate, validity, chargeable.
    OR entry->'toolPricing'->>'unit' IS DISTINCT FROM pe->>'usageUnit'
    OR (entry->'toolPricing'->>'usdPerCurrency')::numeric IS DISTINCT FROM (pe->>'usdPerCurrency')::numeric
    OR pe->'includedInReceipt' IS DISTINCT FROM 'false'::jsonb OR pe->>'validUntil' IS NULL
    OR (entry->'toolPricing'->>'validUntil')::timestamptz IS DISTINCT FROM
      least((pe->>'validUntil')::timestamptz,(pe->>'fxValidUntil')::timestamptz)
    OR (entry->'toolPricing'->>'validUntil')::timestamptz<=clock_timestamp()
    OR bill2_unit_multiplier(entry->'multiplier') IS DISTINCT FROM expected
    THEN RAISE EXCEPTION 'RUNTIME_PRODUCTION_MODEL_DENIED' USING ERRCODE='42501';END IF;
    pe:=NULL;
   END IF;
   CONTINUE;
  END IF;
  SELECT * INTO m FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND is_active='true';
  IF tool_only OR m.id IS NULL OR entry->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1' OR entry->>'provider' IS DISTINCT FROM 'openrouter'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'profiles') prof WHERE prof->>'model'=entry->>'model'
    AND prof->>'endpointTag'=entry->'providerLimits'->>'providerSlug')
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
REVOKE ALL ON FUNCTION public.runtime_production_allowed(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
