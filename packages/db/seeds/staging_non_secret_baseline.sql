--
-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
--

-- Staging-only non-secret baseline seed for #148 Phase 3.
--
-- 正式环境使用前须 Owner 批准（AGENTS.md 第 1 节）。Production use requires Owner approval.
--
-- This file is not an automatic migration. It must be applied only to the
-- staging database. The agent applies it after confirming the staging target
-- (see docs/runbooks/STAGING_REPRODUCIBILITY.md); production use requires
-- Owner approval under AGENTS.md section 1.
--
-- The plan and credit-package rows follow the decided catalog (MASTER_PLAN 2.1 item 51, records F/G/J/S/T;
-- Owner 2026-10-14: free users get no monthly credits, only the 500 sign-up credits). Stripe price ids are
-- never written here: they are derived from payment_provider_refs and set only through pay_common_save_catalog.
--
-- Safety boundaries:
-- - No real provider keys, Supabase keys, connection strings, auth material, or
--   production billing identifiers are stored here.
-- - This seed does not create accounts, assign admin access, run chat, run
--   billing, or change RLS/grants/functions.
-- - Provider secrets remain in the admin Vault and are never set by this seed.

BEGIN;

-- BILL-UNIT: billing_credits_per_usd / billing_token_price_multiplier below are the Owner-decided q=100 / m=6
-- (2026-10-01; a staging environment that runs m=3 has that as an explicit stored row). Never re-run this whole seed
-- on a live staging database: it would also overwrite every other key (ON CONFLICT DO UPDATE).
INSERT INTO public.system_settings (key, value)
VALUES
  ('site_name', to_jsonb('Graylum AI Staging'::text)),
  ('maintenance_mode', 'false'::jsonb),
  ('new_user_credits', '100'::jsonb),
  ('billing_credits_per_usd', '100'::jsonb),
  ('billing_token_price_multiplier', '6'::jsonb),
  ('chat_show_model_selector', 'true'::jsonb),
  ('chat_prompt_text', to_jsonb('Select a staging model to start.'::text)),
  ('chat_welcome_message', to_jsonb('Welcome to the staging baseline.'::text)),
  ('chat_billing_hint', to_jsonb('Staging billing uses non-secret baseline pricing.'::text)),
  ('home_show_onboarding', 'true'::jsonb),
  ('home_show_featured_modules', 'true'::jsonb),
  ('enable_free_tier', 'false'::jsonb),
  ('free_tier_messages', '5'::jsonb),
  ('max_messages_per_conversation', '100'::jsonb),
  ('max_input_characters', '2000'::jsonb),
  ('enable_long_text_warning', 'true'::jsonb),
  ('long_text_warning_threshold', '5000'::jsonb),
  ('show_token_usage_stats', 'true'::jsonb),
  ('input_credits_per_1k', '1'::jsonb),
  ('output_credits_per_1k', '5'::jsonb),
  ('web_search_credits', '5'::jsonb),
  ('search_surcharge_credits', '0'::jsonb),
  ('enable_smart_routing', 'true'::jsonb),
  ('smart_routing_min_confidence', '0.72'::jsonb),
  ('enable_smart_search_decision', 'true'::jsonb),
  ('search_decision_min_confidence', '0.75'::jsonb),
  ('enable_prompt_cache', 'false'::jsonb)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value;

-- A seed replay must not change an amount whose standard Stripe price is currently mapped: that price would stay current and
-- every checkout would fail PAY_COMMON_PRICE_MISMATCH. Like pay_common_save_catalog's PAY_COMMON_PRICE_REPLACEMENT_REQUIRED,
-- refuse here; change such amounts through the admin catalog save, which replaces the price and its mapping together.
DO $seed_price_guard$
BEGIN
  -- Take the row locks pay_common_save_catalog takes, so a concurrent catalog save cannot add a mapping after this check;
  -- this transaction keeps them until the upserts below commit.
  PERFORM 1 FROM public.membership_plans WHERE level IN ('free', 'pro', 'gold') ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.credit_packages WHERE id IN ('30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003') ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('free', 'monthly', 0), ('free', 'yearly', 0), ('pro', 'monthly', 2900), ('pro', 'yearly', 27900),
      ('gold', 'monthly', 6900), ('gold', 'yearly', 62100)) AS seed(level, cycle, amount)
    JOIN public.membership_plans plan ON plan.level = seed.level
    JOIN public.payment_provider_refs ref ON ref.membership_plan_id = plan.id AND ref.object_type = 'price'
      AND ref.billing_cycle = seed.cycle AND ref.is_current AND ref.offer_kind = 'standard'
    WHERE (CASE seed.cycle WHEN 'monthly' THEN plan.monthly_price ELSE plan.yearly_price END) IS DISTINCT FROM seed.amount
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('30000000-0000-4000-8000-000000000001'::uuid, 990), ('30000000-0000-4000-8000-000000000002'::uuid, 2990),
      ('30000000-0000-4000-8000-000000000003'::uuid, 9990)) AS seed(id, amount)
    JOIN public.credit_packages pack ON pack.id = seed.id
    JOIN public.payment_provider_refs ref ON ref.credit_package_id = pack.id AND ref.object_type = 'price'
      AND ref.is_current
    WHERE pack.price IS DISTINCT FROM seed.amount
  ) THEN
    RAISE EXCEPTION 'SEED_PRICE_REPLACEMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;
END
$seed_price_guard$;

INSERT INTO public.membership_plans (
  id,
  name,
  level,
  allow_fusion_review,
  allow_fusion_compare,
  library_storage_bytes,
  allow_publish,
  own_data_window_days,
  allow_benchmark_monitor,
  allow_weekly_auto_review,
  monthly_price,
  yearly_price,
  stripe_monthly_price_id,
  stripe_yearly_price_id,
  monthly_credits,
  yearly_credits,
  monthly_bonus_credits,
  package_discount,
  features,
  history_retention_days,
  max_context_messages,
  allow_export,
  allow_batch_export,
  is_active,
  sort_order,
  updated_at
)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'Free',
    'free',
    false, false, 50000000,
    false, 0, false, false,
    0,
    0,
    NULL,
    NULL,
    0,
    0,
    0,
    100,
    '["新用户可以免费试用"]'::jsonb,
    7,
    10,
    'false',
    'false',
    'true',
    10,
    NOW()
  ),
  -- Pro: $29/month or $279/year; 3,480 credits a month (120 per dollar), yearly paid out as 12 monthly grants;
  -- members buy credit packs at 95%.
  (
    '10000000-0000-4000-8000-000000000002',
    'Pro',
    'pro',
    true, true, 500000000,
    true, 30, false, false,
    2900,
    27900,
    NULL,
    NULL,
    3480,
    41760,
    0,
    95,
    '[]'::jsonb,
    30,
    20,
    'true',
    'false',
    'true',
    20,
    NOW()
  ),
  -- Gold: $69/month or $621/year; 8,970 credits a month (130 per dollar); members buy credit packs at 90%.
  -- The $49 first month and the $496 founder year are checkout offers, not catalog rows.
  (
    '10000000-0000-4000-8000-000000000003',
    'Gold',
    'gold',
    true, true, 2000000000,
    true, 90, true, true,
    6900,
    62100,
    NULL,
    NULL,
    8970,
    107640,
    0,
    90,
    '[]'::jsonb,
    90,
    50,
    'true',
    'true',
    'true',
    30,
    NOW()
  )
-- Preserve the existing plan identity and administrator entitlement edits on replay.
ON CONFLICT (level) DO UPDATE
SET
  name = EXCLUDED.name,
  level = EXCLUDED.level,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price,
  -- stripe_*_price_id are derived from payment_provider_refs (pay_common_plan_derived) and never overwritten here.
  monthly_credits = EXCLUDED.monthly_credits,
  yearly_credits = EXCLUDED.yearly_credits,
  monthly_bonus_credits = EXCLUDED.monthly_bonus_credits,
  package_discount = EXCLUDED.package_discount,
  features = EXCLUDED.features,
  history_retention_days = EXCLUDED.history_retention_days,
  max_context_messages = EXCLUDED.max_context_messages,
  allow_export = EXCLUDED.allow_export,
  allow_batch_export = EXCLUDED.allow_batch_export,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

INSERT INTO public.credit_packages (
  id,
  name,
  price,
  credits_amount,
  bonus_credits,
  stripe_price_id,
  sort_order,
  is_popular,
  active
)
VALUES
  -- Three tiers (records S/T): $9.90 / 990, $29.90 / 2,990, $99.90 / 9,990 + 1,000 bonus. Members only; the Pro 95% /
  -- Gold 90% member prices are rounded down to $0.10 at checkout from package_discount.
  (
    '30000000-0000-4000-8000-000000000001',
    '积分包 小',
    990,
    990,
    0,
    NULL,
    1,
    'false',
    'true'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '积分包 中',
    2990,
    2990,
    0,
    NULL,
    2,
    'false',
    'true'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '积分包 大',
    9990,
    9990,
    1000,
    NULL,
    3,
    'false',
    'true'
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  credits_amount = EXCLUDED.credits_amount,
  bonus_credits = EXCLUDED.bonus_credits,
  -- stripe_price_id is derived from payment_provider_refs and never overwritten here.
  sort_order = EXCLUDED.sort_order,
  is_popular = EXCLUDED.is_popular,
  active = EXCLUDED.active;

-- The pre-decision staging packages stay unsellable wherever an earlier seed created them.
UPDATE public.credit_packages SET active = 'false'
WHERE id IN ('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003') AND active <> 'false';

-- Legacy cost columns below are placeholders for old entry points only.
-- New pricing paths use OpenRouter config.pricing; remove these with LEGACY-CLOSE.
INSERT INTO public.ai_models (
  id,
  name,
  model_id,
  provider,
  api_endpoint,
  description,
  max_tokens,
  input_limit,
  enable_web_search,
  input_token_cost,
  output_token_cost,
  input_token_cost_above_200k,
  output_token_cost_above_200k,
  web_search_cost,
  token_counting_supported,
  token_counting_method,
  tokenizer_family,
  is_active,
  config,
  updated_at
)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    'Staging Baseline Primary',
    'staging-baseline-primary',
    'builtin',
    NULL,
    'Non-secret staging readiness row. Configure provider routing outside this seed before real smoke.',
    4096,
    180000,
    'false',
    3000,
    15000,
    6000,
    22500,
    0,
    'false',
    'unsupported',
    NULL,
    'true',
    '{"seed":"staging_non_secret_baseline","realProviderConfigured":false}'::jsonb,
    NOW()
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'Staging Baseline Assistant',
    'staging-baseline-assistant',
    'builtin',
    NULL,
    'Non-secret staging readiness row for low-cost routing placeholders.',
    2048,
    64000,
    'false',
    1000,
    5000,
    2000,
    7500,
    0,
    'false',
    'unsupported',
    NULL,
    'true',
    '{"seed":"staging_non_secret_baseline","realProviderConfigured":false}'::jsonb,
    NOW()
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  model_id = EXCLUDED.model_id,
  provider = EXCLUDED.provider,
  api_endpoint = EXCLUDED.api_endpoint,
  description = EXCLUDED.description,
  max_tokens = EXCLUDED.max_tokens,
  input_limit = EXCLUDED.input_limit,
  enable_web_search = EXCLUDED.enable_web_search,
  input_token_cost = EXCLUDED.input_token_cost,
  output_token_cost = EXCLUDED.output_token_cost,
  input_token_cost_above_200k = EXCLUDED.input_token_cost_above_200k,
  output_token_cost_above_200k = EXCLUDED.output_token_cost_above_200k,
  web_search_cost = EXCLUDED.web_search_cost,
  token_counting_supported = EXCLUDED.token_counting_supported,
  token_counting_method = EXCLUDED.token_counting_method,
  tokenizer_family = EXCLUDED.tokenizer_family,
  is_active = EXCLUDED.is_active,
  config = EXCLUDED.config,
  updated_at = NOW();

COMMIT;
