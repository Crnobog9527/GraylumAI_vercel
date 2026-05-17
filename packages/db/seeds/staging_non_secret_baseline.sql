--
-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
--

-- Staging-only non-secret baseline seed for #148 Phase 3.
--
-- This file is not an automatic migration. It must be applied only to the
-- staging database, and only after explicit owner approval for that write.
--
-- Safety boundaries:
-- - No real provider keys, Supabase keys, connection strings, auth material, or
--   production billing identifiers are stored here.
-- - ai_models.api_key is intentionally NULL.
-- - This seed does not create accounts, assign admin access, run chat, run
--   billing, or change RLS/grants/functions.
-- - OPENROUTER_API_KEY and all other secrets remain owner-provided outside the
--   repository.

BEGIN;

INSERT INTO public.system_settings (key, value)
VALUES
  ('site_name', to_jsonb('Graylum AI Staging'::text)),
  ('maintenance_mode', 'false'::jsonb),
  ('new_user_credits', '100'::jsonb),
  ('billing_credits_per_usd', '1000'::jsonb),
  ('billing_token_price_multiplier', '1.5'::jsonb),
  ('billing_min_pre_deduct', '10'::jsonb),
  ('billing_max_pre_deduct', '10000'::jsonb),
  ('billing_safety_margin', '0.2'::jsonb),
  ('billing_require_model_pricing', 'true'::jsonb),
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

INSERT INTO public.membership_plans (
  id,
  name,
  level,
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
    0,
    0,
    NULL,
    NULL,
    100,
    1200,
    0,
    100,
    '["Basic staging access", "Short context retention"]'::jsonb,
    7,
    10,
    'false',
    'false',
    'true',
    10,
    NOW()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Pro',
    'pro',
    990,
    9900,
    NULL,
    NULL,
    1500,
    20000,
    0,
    100,
    '["Extended staging context", "Export enabled"]'::jsonb,
    30,
    20,
    'true',
    'false',
    'true',
    20,
    NOW()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'Gold',
    'gold',
    2990,
    29900,
    NULL,
    NULL,
    5000,
    70000,
    500,
    90,
    '["Long staging context", "Batch export enabled"]'::jsonb,
    90,
    50,
    'true',
    'true',
    'true',
    30,
    NOW()
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  level = EXCLUDED.level,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price,
  stripe_monthly_price_id = EXCLUDED.stripe_monthly_price_id,
  stripe_yearly_price_id = EXCLUDED.stripe_yearly_price_id,
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
  (
    '20000000-0000-4000-8000-000000000001',
    'Staging Starter Credits',
    500,
    500,
    0,
    NULL,
    10,
    'false',
    'true'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Staging Plus Credits',
    1500,
    1800,
    150,
    NULL,
    20,
    'true',
    'true'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'Staging Max Credits',
    5000,
    6500,
    1000,
    NULL,
    30,
    'false',
    'true'
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  credits_amount = EXCLUDED.credits_amount,
  bonus_credits = EXCLUDED.bonus_credits,
  stripe_price_id = EXCLUDED.stripe_price_id,
  sort_order = EXCLUDED.sort_order,
  is_popular = EXCLUDED.is_popular,
  active = EXCLUDED.active;

INSERT INTO public.ai_models (
  id,
  name,
  model_id,
  provider,
  api_key,
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
  api_key = NULL,
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
