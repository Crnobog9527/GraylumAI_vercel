-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
--
-- REL-1 B3/B7 only. NOT a migration or an automatic deployment step.
-- Sources below are repository-relative. PREP = docs/launch/tasks/REL-1-BUILD-PREP.md §1;
-- PLAN = docs/launch/MASTER_PLAN.md §2.1; REL = docs/launch/tasks/REL-1.md §3.3.
-- Owner approval on build day is still required. Send this entire file to the server as one SQL string.
-- Never run on staging. No keys, identities, email addresses, provider IDs, price snapshots or test windows.
--
-- Build-day order: B1 schema -> B2 production marker -> B3 model/Skill import -> fill the block below
-- in a PRIVATE execution copy -> Owner-approved execution -> B8 readback. Never commit that filled copy.
-- Model/Skill imports, routing/reasoning config and the 32768 output ceiling are separate B3/B7 checks;
-- this file neither invents model prices/routes nor publishes Skills. Its UUIDs reference those imports.
-- All null fields below (including nested fields) are REQUIRED placeholders; no row is written until every field is replaced.
-- runtime_purpose_budgets: JSON STRING containing frozen-budget JSON (PREP 1.2 A; REL B3).
-- billing_payg_start_thresholds: OBJECT {version,thresholds}, frozen design (PREP 1.2 A; REL B7).
-- fusion_settings: OBJECT per services/fusion/settings.ts; production UUIDs, compare enabled, four allowed
-- Sonnet/Flash/Sol/Opus, defaults Sonnet/Flash/Sol, minModels=2, answerOutputTokens=8192, maxBudgetUsd="5";
-- Review template defaults follow services/fusion/settings.ts; frozen review budget must be supplied.
-- PLAN 2026-10-20: Sonnet=evidence, Sol=finance, Argon=execution; fill reviewerRoles with those UUID keys.
-- review uses Sonnet/Sol/Argon and Opus summary (PLAN 2026-10-25/26; PREP 1.2 A, 1.5; REL B7).
-- primary_model_id: production Sonnet 5.5 UUID; v3_summary_model_id: production GPT-6 Luna UUID (PREP 1.2 A).
-- publish_monitor_review_model_id: production UUID, deliberately NULL until build day (PREP 1.2 A).
-- publish_monitor_publish_quota: OBJECT {limit,periodAnchor}; actual paid project's positive integer limit
-- and ISO timestamp from Post for Me, not staging quota (PREP 1.2 A; REL B7).
--
-- Deliberate omissions, keyed to PREP §1 (not silently treated as completed):
-- 1.2 A: runtime_payg_staging NEVER copied; runtime_payg_production is a separate B4 approval.
-- payment_terms_version/payment_method_routes/launch_baseline_at/payment_provider_refs belong to B5.
-- runtime_rate_limits belongs to B6; runtime_stop_loss/support_email/secrets are entered by Owner (B11/P4).
-- research_tools_config: formal admin must re-attest supplier hard caps through the admin UI (B7/P4);
-- that config contains an account UUID/time, prohibited here. billing_provider_prices: K12 refresh only.
-- 1.2 B: every 'not needed/legacy' key and every 'pending controller decision' key is omitted, including
-- v3_summary_max_tokens/max_input_characters/founder_community_entry/home_analysis_module_id.
-- Deleted check-in keys are never written. No staging-only pricing, windows or connection-test records.
-- 1.2 C: model_identity_guard uses enabled default; orphan deletion and publish_listed wait for their gates.
-- 1.2 D: runtime_environment is a separate B2 step, checked below but never set here.
-- 1.5/1.6: model and private Skill content imported separately; no Qwen or unapproved Skill publication.
-- 1.7/1.8: live payment mappings and secret slots are separate operations, never copied from staging.
--
-- Recovery: only before traffic/payment, restore the three affected tables from the approved pre-seed
-- configuration snapshot in one transaction; an empty disposable build may instead be rebuilt from files.
-- Never delete retained rows/financial history to recover. After opening, use a separately approved change.

BEGIN;
SET LOCAL lock_timeout = '5s';
DO $production_seed$
DECLARE
  build_day jsonb := $build_day${
    "runtime_purpose_budgets": null,
    "billing_payg_start_thresholds": null,
    "fusion_settings": {
      "version": 1,
      "compare": {"enabled":true,"allowedModelIds":[null,null,null,null],"defaultModelIds":[null,null,null],
        "minModels":2,"answerOutputTokens":8192,"maxBudgetUsd":"5","dispatchMinutes":10,
        "breaker":{"platformUsd":"2","noDeliveryCalls":10}},
      "review": {"enabled":true,"reviewerModelIds":[null,null,null],"summaryModelId":null,"skillId":null,
        "maxRounds":1,"opinionOutputTokens":4096,"summaryOutputTokens":32768,"maxBudgetUsd":null,
        "fixedPriceCredits":1500,"dispatchMinutes":10,"breaker":{"platformUsd":"2","noDeliveryCalls":10},
        "displayNames":{"reviewers":["评审 A","评审 B","评审 C"],"summary":"汇总"},"reviewerRoles":null}
    },
    "primary_model_id": null,
    "v3_summary_model_id": null,
    "publish_monitor_review_model_id": null,
    "publish_monitor_publish_quota": null
  }$build_day$::jsonb;
  item record;
  fusion jsonb;
  budgets jsonb;
  entry jsonb;
BEGIN
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(build_day) AS k(key)) IS DISTINCT FROM
    ARRAY['billing_payg_start_thresholds','fusion_settings','primary_model_id','publish_monitor_publish_quota',
      'publish_monitor_review_model_id','runtime_purpose_budgets','v3_summary_model_id'] THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_INPUT_KEYS_REQUIRED';
  END IF;
  -- Fail before any DML, including when only one placeholder remains. Never log filled values.
  FOR item IN SELECT key, value FROM jsonb_each(build_day) LOOP
    IF jsonb_path_exists(item.value, '$.** ? (@ == null)') OR item.value::text LIKE '%__REPLACE_%' THEN
      RAISE EXCEPTION 'PRODUCTION_SEED_REPLACE_REQUIRED: %', item.key;
    END IF;
  END LOOP;
  IF (SELECT value FROM public.system_settings WHERE key = 'runtime_environment')
    IS DISTINCT FROM '"production"'::jsonb THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_B2_REQUIRED';
  END IF;
  -- Serialize catalog writes with the existing admin catalog path, and protect mapped prices on replay.
  LOCK TABLE public.membership_plans, public.credit_packages, public.payment_provider_refs IN SHARE ROW EXCLUSIVE MODE;
  FOR item IN SELECT key, value FROM jsonb_each(build_day)
    WHERE key IN ('primary_model_id', 'v3_summary_model_id', 'publish_monitor_review_model_id') LOOP
    IF jsonb_typeof(item.value) <> 'string' OR NOT EXISTS (
      SELECT 1 FROM public.ai_models WHERE id::text = item.value #>> '{}' AND is_active = 'true'
        AND (item.key = 'publish_monitor_review_model_id'
          OR (item.key = 'primary_model_id' AND model_id = 'anthropic/claude-sonnet-5.5')
          OR (item.key = 'v3_summary_model_id' AND model_id = 'openai/gpt-6-luna'))
    ) THEN RAISE EXCEPTION 'PRODUCTION_SEED_MODEL_REQUIRED: %', item.key; END IF;
  END LOOP;
  IF jsonb_typeof(build_day->'runtime_purpose_budgets') <> 'string' THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_BUDGET_STRING_REQUIRED';
  END IF;
  budgets := (build_day->>'runtime_purpose_budgets')::jsonb;
  -- Match purposeBudgets.ts (v1 rollback-compatible strings and v2 strings), not just outer key names.
  IF jsonb_typeof(budgets) IS DISTINCT FROM 'object'
    OR NOT (budgets ?& ARRAY['version','interactive','organize','report'])
    OR budgets - ARRAY['version','interactive','organize','report'] <> '{}'::jsonb
    OR budgets->'version' NOT IN ('1'::jsonb,'2'::jsonb) THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_BUDGET_REQUIRED';
  END IF;
  FOR item IN SELECT * FROM (VALUES ('interactive',90000),('organize',112000),('report',196608)) cfg(purpose,cap) LOOP
    entry := budgets->item.purpose;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR NOT (entry ?& ARRAY['inputBytes','historyItems'])
      OR jsonb_typeof(entry->'inputBytes') IS DISTINCT FROM 'number'
      OR jsonb_typeof(entry->'historyItems') IS DISTINCT FROM 'number'
      OR (entry->>'inputBytes') !~ '^[0-9]+$' OR (entry->>'historyItems') !~ '^[0-9]+$'
      OR (entry->>'inputBytes')::numeric NOT BETWEEN 1024 AND item.cap
      OR (entry->>'historyItems')::numeric NOT BETWEEN 0 AND 1000 THEN
      RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_BUDGET_REQUIRED';
    END IF;
    IF budgets->'version' = '1'::jsonb AND item.purpose IN ('interactive','report') THEN
      IF NOT (entry ? 'maxOutputTokens') OR entry - ARRAY['inputBytes','historyItems','maxOutputTokens'] <> '{}'::jsonb
        OR jsonb_typeof(entry->'maxOutputTokens') IS DISTINCT FROM 'number'
        OR (entry->>'maxOutputTokens') !~ '^[0-9]+$'
        OR (entry->>'maxOutputTokens')::numeric NOT BETWEEN 1 AND 32768 THEN
        RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_BUDGET_REQUIRED';
      END IF;
    ELSIF entry - ARRAY['inputBytes','historyItems'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_BUDGET_REQUIRED';
    END IF;
  END LOOP;
  -- Match adminSettings.ts paygStartThresholdsSchema: model/purpose, exact USD OR legacy credits, no duplicates.
  IF jsonb_typeof(build_day->'billing_payg_start_thresholds') <> 'object'
    OR jsonb_typeof(build_day#>'{billing_payg_start_thresholds,thresholds}') IS DISTINCT FROM 'array'
    OR coalesce(jsonb_array_length(build_day#>'{billing_payg_start_thresholds,thresholds}'), 0) = 0
    OR jsonb_typeof(build_day#>'{billing_payg_start_thresholds,version}') IS DISTINCT FROM 'string'
    OR btrim(coalesce(build_day#>>'{billing_payg_start_thresholds,version}', '')) = '' THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED';
  END IF;
  FOR entry IN SELECT jsonb_array_elements(build_day#>'{billing_payg_start_thresholds,thresholds}') LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR jsonb_typeof(entry->'model') IS DISTINCT FROM 'string' OR coalesce(entry->>'model','') = ''
      OR jsonb_typeof(entry->'purpose') IS DISTINCT FROM 'string' OR coalesce(entry->>'purpose','') = ''
      OR (entry ? 'typicalUsd') = (entry ? 'credits') THEN
      RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED';
    END IF;
    IF entry ? 'typicalUsd' THEN
      IF jsonb_typeof(entry->'typicalUsd') <> 'string'
        OR (entry->>'typicalUsd') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' THEN
        RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED';
      END IF;
    ELSIF jsonb_typeof(entry->'credits') NOT IN ('number','string')
      OR (entry->>'credits') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(build_day#>'{billing_payg_start_thresholds,thresholds}') e
    GROUP BY e->>'model',e->>'purpose' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FROZEN_THRESHOLDS_REQUIRED';
  END IF;
  fusion := build_day->'fusion_settings';
  IF (fusion @> '{"version":1,"compare":{"enabled":true,"minModels":2,
      "answerOutputTokens":8192,"maxBudgetUsd":"5"},"review":{"enabled":true,"maxRounds":1}}'::jsonb) IS DISTINCT FROM true
    OR coalesce(jsonb_array_length(fusion#>'{compare,allowedModelIds}'), 0) <> 4
    OR coalesce(jsonb_array_length(fusion#>'{compare,defaultModelIds}'), 0) <> 3
    OR coalesce(jsonb_array_length(fusion#>'{review,reviewerModelIds}'), 0) <> 3 THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FUSION_REQUIRED';
  END IF;
  IF NOT (fusion->'review' ?& ARRAY['reviewerModelIds','summaryModelId','skillId','maxRounds',
      'opinionOutputTokens','summaryOutputTokens','maxBudgetUsd','dispatchMinutes','breaker'])
    OR jsonb_typeof(fusion#>'{review,opinionOutputTokens}') <> 'number'
    OR (fusion#>>'{review,opinionOutputTokens}')::integer NOT BETWEEN 512 AND 32768
    OR jsonb_typeof(fusion#>'{review,summaryOutputTokens}') <> 'number'
    OR (fusion#>>'{review,summaryOutputTokens}')::integer NOT BETWEEN 1024 AND 32768
    OR jsonb_typeof(fusion#>'{review,dispatchMinutes}') <> 'number'
    OR (fusion#>>'{review,dispatchMinutes}')::integer NOT BETWEEN 1 AND 60
    OR jsonb_typeof(fusion#>'{review,maxBudgetUsd}') <> 'string'
    OR (fusion#>>'{review,maxBudgetUsd}') !~ '^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$'
    OR (fusion#>>'{review,maxBudgetUsd}')::numeric <= 0
    OR NOT (fusion#>'{review,breaker}' ?& ARRAY['platformUsd','noDeliveryCalls']) THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FUSION_REQUIRED';
  END IF;
  -- Use model identities, never a staging UUID. Array equality also forbids duplicates/wrong seats.
  IF (SELECT array_agg(model_id ORDER BY model_id) FROM public.ai_models WHERE is_active = 'true' AND id::text IN
      (SELECT jsonb_array_elements_text(fusion#>'{compare,allowedModelIds}')))
    IS DISTINCT FROM ARRAY['anthropic/claude-opus-5.5','anthropic/claude-sonnet-5.5',
      'google/gemini-3.8-flash','openai/gpt-6.1-sol']
    OR (SELECT array_agg(model_id ORDER BY model_id) FROM public.ai_models WHERE is_active = 'true' AND id::text IN
      (SELECT jsonb_array_elements_text(fusion#>'{compare,defaultModelIds}')))
    IS DISTINCT FROM ARRAY['anthropic/claude-sonnet-5.5','google/gemini-3.8-flash','openai/gpt-6.1-sol']
    OR (SELECT array_agg(model_id ORDER BY model_id) FROM public.ai_models WHERE is_active = 'true' AND id::text IN
      (SELECT jsonb_array_elements_text(fusion#>'{review,reviewerModelIds}')))
    IS DISTINCT FROM ARRAY['anthropic/claude-sonnet-5.5','google/gemini-4-argon','openai/gpt-6.1-sol']
    OR NOT EXISTS (SELECT 1 FROM public.ai_models WHERE id::text = fusion#>>'{review,summaryModelId}'
      AND model_id = 'anthropic/claude-opus-5.5' AND is_active = 'true')
    OR NOT EXISTS (SELECT 1 FROM public.skills WHERE id::text = fusion#>>'{review,skillId}')
    OR fusion#>'{review,reviewerRoles}' IS DISTINCT FROM (SELECT jsonb_object_agg(id::text,
      CASE model_id WHEN 'anthropic/claude-sonnet-5.5' THEN 'evidence'
        WHEN 'openai/gpt-6.1-sol' THEN 'finance' ELSE 'execution' END)
      FROM public.ai_models WHERE id::text IN (SELECT jsonb_array_elements_text(fusion#>'{review,reviewerModelIds}'))) THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_FUSION_IMPORT_REQUIRED';
  END IF;
  IF jsonb_typeof(build_day#>'{publish_monitor_publish_quota,limit}') IS DISTINCT FROM 'number'
    OR (build_day#>>'{publish_monitor_publish_quota,limit}')::numeric <= 0
    OR mod((build_day#>>'{publish_monitor_publish_quota,limit}')::numeric, 1) <> 0
    OR coalesce(build_day#>>'{publish_monitor_publish_quota,periodAnchor}', '') = '' THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_PUBLISH_QUOTA_REQUIRED';
  END IF;
  IF jsonb_typeof(build_day#>'{publish_monitor_publish_quota,periodAnchor}') IS DISTINCT FROM 'string'
    OR NOT isfinite((build_day#>>'{publish_monitor_publish_quota,periodAnchor}')::timestamptz)
    OR (build_day#>>'{publish_monitor_publish_quota,periodAnchor}')::timestamptz > now() THEN
    RAISE EXCEPTION 'PRODUCTION_SEED_PUBLISH_QUOTA_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES ('free',0,0),('pro',2900,27900),('gold',6900,62100)) AS seed(level,monthly,yearly)
    JOIN public.membership_plans p ON p.level = seed.level
    JOIN public.payment_provider_refs r ON r.membership_plan_id = p.id AND r.object_type = 'price'
      AND r.is_current AND r.offer_kind = 'standard'
    WHERE p.monthly_price <> seed.monthly OR p.yearly_price <> seed.yearly
  ) OR EXISTS (
    SELECT 1 FROM (VALUES ('30000000-0000-4000-8000-000000000001'::uuid,990),
      ('30000000-0000-4000-8000-000000000002'::uuid,2990),
      ('30000000-0000-4000-8000-000000000003'::uuid,9990)) AS seed(id,price)
    JOIN public.credit_packages p ON p.id = seed.id
    JOIN public.payment_provider_refs r ON r.credit_package_id = p.id AND r.object_type = 'price' AND r.is_current
    WHERE p.price <> seed.price
  ) THEN RAISE EXCEPTION 'SEED_PRICE_REPLACEMENT_REQUIRED'; END IF;

  INSERT INTO public.system_settings (key, value) VALUES
    -- PREP 1.2 A / REL B3; PLAN 2026-10-01 BILL-UNIT q=100, m=6 (NOT staging m=3).
    ('billing_credits_per_usd', '"100"'::jsonb),
    ('billing_token_price_multiplier', '"6"'::jsonb),
    -- PREP 1.2 B + §4 problem 1; REL B7: object, not scalar boolean.
    ('runtime_report_generation', '{"enabled":true}'::jsonb),
    -- PREP 1.2 A / REL B7, core 11 research tools.
    ('chat_research_tools_enabled', 'true'::jsonb),
    -- PREP 1.2 A / REL B7, core 4 library; PLAN 2026-10-17 automatic context.
    ('library_agent_read_enabled', 'true'::jsonb),
    ('chat_library_retrieval_enabled', 'true'::jsonb),
    ('library_scan_recognition_enabled', 'true'::jsonb),
    ('library_upload_enabled', 'true'::jsonb),
    -- PREP 1.2 A / REL B7; PLAN 2026-10-26: works review opens at launch.
    ('chat_my_posts_enabled', 'true'::jsonb),
    ('publish_monitor_enabled', 'true'::jsonb),
    ('publish_monitor_review_enabled', 'true'::jsonb),
    ('publish_monitor_review_max_usd', '"0.30"'::jsonb),
    -- PREP 1.2 A / REL §7 E1; PLAN 2026-10-24 (recorded 10-25): all nine platforms.
    ('publish_monitor_publish_platforms',
      '["tiktok","instagram","youtube","facebook","x","threads","linkedin","pinterest","bluesky"]'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  WHERE system_settings.value IS DISTINCT FROM EXCLUDED.value;

  -- PREP 1.2 A / REL B3/B7: required build-day values, with their sources above the placeholder block.
  INSERT INTO public.system_settings (key, value) SELECT key, value FROM jsonb_each(build_day)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  WHERE system_settings.value IS DISTINCT FROM EXCLUDED.value;

  -- PREP 1.3 / REL B3/B7. PLAN §2.1 item 51 F/G/J: $29/$69 monthly, $279/$621 yearly;
  -- monthly credits 29*120=3480 / 69*130=8970; yearly 12 monthly grants = 41760/107640.
  -- Free 0/0: PLAN 2026-10-14 (signup 500 is a separate existing grant, never an extra seed).
  -- Discounts 95/90: item 51; entitlement columns: PREP 1.3, PLAN 2026-10-17 and REL B7 (Gold only Fusion).
  -- First month $49 (PLAN 2026-10-12, item 51 G/H/I), founder $496/year (item 51 F/J/P and 10-14):
  -- checkout offers, NOT extra plan rows; B5/S4 maps them privately. Never replace Gold standard prices.
  INSERT INTO public.membership_plans AS p (name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    monthly_bonus_credits,package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
    allow_publish,own_data_window_days,allow_benchmark_monitor,allow_weekly_auto_review,
    positioning_profile_limit,history_retention_days,is_active,sort_order)
  VALUES
    ('Free','free',0,0,0,0,0,100,false,false,50000000,false,0,false,false,1,7,'true',10),
    ('Pro','pro',2900,27900,3480,41760,0,95,false,false,500000000,true,30,false,false,3,30,'true',20),
    ('Gold','gold',6900,62100,8970,107640,0,90,true,true,2000000000,true,90,true,true,6,90,'true',30)
  ON CONFLICT (level) DO UPDATE SET
    name=EXCLUDED.name, monthly_price=EXCLUDED.monthly_price, yearly_price=EXCLUDED.yearly_price,
    monthly_credits=EXCLUDED.monthly_credits, yearly_credits=EXCLUDED.yearly_credits,
    monthly_bonus_credits=EXCLUDED.monthly_bonus_credits, package_discount=EXCLUDED.package_discount,
    allow_fusion_review=EXCLUDED.allow_fusion_review, allow_fusion_compare=EXCLUDED.allow_fusion_compare,
    library_storage_bytes=EXCLUDED.library_storage_bytes, allow_publish=EXCLUDED.allow_publish,
    own_data_window_days=EXCLUDED.own_data_window_days, allow_benchmark_monitor=EXCLUDED.allow_benchmark_monitor,
    allow_weekly_auto_review=EXCLUDED.allow_weekly_auto_review, positioning_profile_limit=EXCLUDED.positioning_profile_limit,
    history_retention_days=EXCLUDED.history_retention_days, is_active=EXCLUDED.is_active, sort_order=EXCLUDED.sort_order,
    updated_at=now()
  WHERE (p.name,p.monthly_price,p.yearly_price,p.monthly_credits,p.yearly_credits,p.monthly_bonus_credits,p.package_discount,
    p.allow_fusion_review,p.allow_fusion_compare,p.library_storage_bytes,p.allow_publish,p.own_data_window_days,
    p.allow_benchmark_monitor,p.allow_weekly_auto_review,p.positioning_profile_limit,p.history_retention_days,p.is_active,p.sort_order)
  IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.monthly_price,EXCLUDED.yearly_price,EXCLUDED.monthly_credits,EXCLUDED.yearly_credits,
    EXCLUDED.monthly_bonus_credits,EXCLUDED.package_discount,EXCLUDED.allow_fusion_review,EXCLUDED.allow_fusion_compare,
    EXCLUDED.library_storage_bytes,EXCLUDED.allow_publish,EXCLUDED.own_data_window_days,EXCLUDED.allow_benchmark_monitor,
    EXCLUDED.allow_weekly_auto_review,EXCLUDED.positioning_profile_limit,EXCLUDED.history_retention_days,EXCLUDED.is_active,
    EXCLUDED.sort_order);

  -- PREP 1.4; PLAN item 51 S/T + item 50: $9.90/990, $29.90/2990, $99.90/9990+1000.
  -- These are deterministic INTERNAL catalog IDs, not any platform's identifiers. No Stripe columns are written.
  -- Pro/Gold discounts round DOWN to $0.10 at checkout (item 51 T); no test packages imported/deactivated here.
  INSERT INTO public.credit_packages AS p (id,name,price,credits_amount,bonus_credits,sort_order,is_popular,active)
  VALUES
    ('30000000-0000-4000-8000-000000000001','积分包 小',990,990,0,1,'false','true'),
    ('30000000-0000-4000-8000-000000000002','积分包 中',2990,2990,0,2,'false','true'),
    ('30000000-0000-4000-8000-000000000003','积分包 大',9990,9990,1000,3,'false','true')
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,price=EXCLUDED.price,credits_amount=EXCLUDED.credits_amount,
    bonus_credits=EXCLUDED.bonus_credits,sort_order=EXCLUDED.sort_order,is_popular=EXCLUDED.is_popular,
    active=EXCLUDED.active
  WHERE (p.name,p.price,p.credits_amount,p.bonus_credits,p.sort_order,p.is_popular,p.active)
    IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.price,EXCLUDED.credits_amount,EXCLUDED.bonus_credits,EXCLUDED.sort_order,
      EXCLUDED.is_popular,EXCLUDED.active);
END
$production_seed$;
COMMIT;
