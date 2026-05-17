/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- #148 Phase 3 staging seed baseline.
--
-- Apply this file only to the confirmed staging database after owner approval.
-- This is an explicit seed script, not an automatic migration. It intentionally
-- contains no provider API keys, auth credentials, live user data, or production
-- billing identifiers.

BEGIN;

INSERT INTO public.system_settings (key, value)
VALUES
  ('site_name', to_jsonb('Graylum AI Staging'::text)),
  ('support_email', to_jsonb('support@example.invalid'::text)),
  ('maintenance_mode', to_jsonb('false'::text)),
  ('home_show_onboarding', to_jsonb('true'::text)),
  ('home_show_featured_modules', to_jsonb('true'::text)),
  ('chat_show_model_selector', to_jsonb('true'::text)),
  ('max_input_characters', to_jsonb('2000'::text)),
  ('enable_free_tier', to_jsonb('false'::text)),
  ('free_tier_messages', to_jsonb('5'::text)),
  ('enable_long_text_warning', to_jsonb('true'::text)),
  ('long_text_warning_threshold', to_jsonb('5000'::text)),
  ('show_token_usage_stats', to_jsonb('true'::text)),
  ('chat_prompt_text', to_jsonb('Choose a model to start chatting.'::text)),
  ('chat_welcome_message', to_jsonb('Hello. How can I help?'::text)),
  ('chat_billing_hint', to_jsonb('Usage is billed from actual tokens: input {input} credits/1K tokens, output {output} credits/1K tokens.'::text)),
  ('input_credits_per_1k', to_jsonb('1'::text)),
  ('output_credits_per_1k', to_jsonb('5'::text)),
  ('new_user_credits', to_jsonb('100'::text)),
  ('billing_credits_per_usd', to_jsonb('1000'::text)),
  ('billing_token_price_multiplier', to_jsonb('1.5'::text)),
  ('billing_min_pre_deduct', to_jsonb('10'::text)),
  ('billing_max_pre_deduct', to_jsonb('10000'::text)),
  ('billing_safety_margin', to_jsonb('0.2'::text)),
  ('billing_require_model_pricing', to_jsonb('true'::text)),
  ('enable_smart_routing', to_jsonb('true'::text)),
  ('smart_routing_min_confidence', to_jsonb('0.72'::text)),
  ('primary_model_id', to_jsonb('6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::text)),
  ('assistant_model_id', to_jsonb('6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::text)),
  ('enable_smart_search_decision', to_jsonb('true'::text)),
  ('search_decision_min_confidence', to_jsonb('0.75'::text)),
  ('search_surcharge_credits', to_jsonb('0'::text)),
  ('enable_prompt_cache', to_jsonb('false'::text)),
  (
    'ai_models',
    jsonb_build_object(
      'primaryModelId', '6f3c8d0e-0b2a-4a5d-8d0d-148000000001',
      'assistantModelId', '6f3c8d0e-0b2a-4a5d-8d0d-148000000002',
      'defaultModelId', '6f3c8d0e-0b2a-4a5d-8d0d-148000000001',
      'sonnetModelId', '6f3c8d0e-0b2a-4a5d-8d0d-148000000001',
      'haikuModelId', '6f3c8d0e-0b2a-4a5d-8d0d-148000000002',
      'enableSmartRouting', true,
      'enableSmartSearchDecision', true,
      'enablePromptCache', false
    )
  )
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value;

DO $$
DECLARE
  v_primary_model_id uuid;
  v_assistant_model_id uuid;
BEGIN
  SELECT id
  INTO v_primary_model_id
  FROM public.ai_models
  WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::uuid
    OR model_id = 'anthropic/claude-sonnet-4.6'
  ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::uuid) DESC, created_at ASC
  LIMIT 1;

  IF v_primary_model_id IS NULL THEN
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
      config
    )
    VALUES (
      '6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::uuid,
      'Staging Claude Sonnet via OpenRouter',
      'anthropic/claude-sonnet-4.6',
      'openai',
      NULL,
      'https://openrouter.ai/api/v1/chat/completions',
      'Staging baseline model. Runtime provider credentials stay outside the database row.',
      8192,
      200000,
      'false',
      3000000,
      15000000,
      6000000,
      22500000,
      0,
      'true',
      'provider_usage',
      'openai',
      'true',
      jsonb_build_object('seedSource', '#148 phase 3 staging non-secret baseline')
    );
  ELSE
    UPDATE public.ai_models
    SET
      name = 'Staging Claude Sonnet via OpenRouter',
      model_id = 'anthropic/claude-sonnet-4.6',
      provider = 'openai',
      api_key = NULL,
      api_endpoint = 'https://openrouter.ai/api/v1/chat/completions',
      description = 'Staging baseline model. Runtime provider credentials stay outside the database row.',
      max_tokens = 8192,
      input_limit = 200000,
      enable_web_search = 'false',
      input_token_cost = 3000000,
      output_token_cost = 15000000,
      input_token_cost_above_200k = 6000000,
      output_token_cost_above_200k = 22500000,
      web_search_cost = 0,
      token_counting_supported = 'true',
      token_counting_method = 'provider_usage',
      tokenizer_family = 'openai',
      is_active = 'true',
      config = jsonb_build_object('seedSource', '#148 phase 3 staging non-secret baseline'),
      updated_at = NOW()
    WHERE id = v_primary_model_id;
  END IF;

  SELECT id
  INTO v_assistant_model_id
  FROM public.ai_models
  WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::uuid
    OR model_id = 'anthropic/claude-haiku-4.5'
  ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::uuid) DESC, created_at ASC
  LIMIT 1;

  IF v_assistant_model_id IS NULL THEN
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
      config
    )
    VALUES (
      '6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::uuid,
      'Staging Claude Haiku via OpenRouter',
      'anthropic/claude-haiku-4.5',
      'openai',
      NULL,
      'https://openrouter.ai/api/v1/chat/completions',
      'Staging baseline assistant model. Runtime provider credentials stay outside the database row.',
      8192,
      200000,
      'false',
      800000,
      4000000,
      1600000,
      6000000,
      0,
      'true',
      'provider_usage',
      'openai',
      'true',
      jsonb_build_object('seedSource', '#148 phase 3 staging non-secret baseline')
    );
  ELSE
    UPDATE public.ai_models
    SET
      name = 'Staging Claude Haiku via OpenRouter',
      model_id = 'anthropic/claude-haiku-4.5',
      provider = 'openai',
      api_key = NULL,
      api_endpoint = 'https://openrouter.ai/api/v1/chat/completions',
      description = 'Staging baseline assistant model. Runtime provider credentials stay outside the database row.',
      max_tokens = 8192,
      input_limit = 200000,
      enable_web_search = 'false',
      input_token_cost = 800000,
      output_token_cost = 4000000,
      input_token_cost_above_200k = 1600000,
      output_token_cost_above_200k = 6000000,
      web_search_cost = 0,
      token_counting_supported = 'true',
      token_counting_method = 'provider_usage',
      tokenizer_family = 'openai',
      is_active = 'true',
      config = jsonb_build_object('seedSource', '#148 phase 3 staging non-secret baseline'),
      updated_at = NOW()
    WHERE id = v_assistant_model_id;
  END IF;
END $$;

WITH selected_models AS (
  SELECT
    (
      SELECT id::text
      FROM public.ai_models
      WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::uuid
        OR model_id = 'anthropic/claude-sonnet-4.6'
      ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000001'::uuid) DESC, created_at ASC
      LIMIT 1
    ) AS primary_model_id,
    (
      SELECT id::text
      FROM public.ai_models
      WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::uuid
        OR model_id = 'anthropic/claude-haiku-4.5'
      ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000002'::uuid) DESC, created_at ASC
      LIMIT 1
    ) AS assistant_model_id
)
INSERT INTO public.system_settings (key, value)
SELECT key, value
FROM selected_models
CROSS JOIN LATERAL (
  VALUES
    ('primary_model_id', to_jsonb(selected_models.primary_model_id)),
    ('assistant_model_id', to_jsonb(selected_models.assistant_model_id)),
    (
      'ai_models',
      jsonb_build_object(
        'primaryModelId', selected_models.primary_model_id,
        'assistantModelId', selected_models.assistant_model_id,
        'defaultModelId', selected_models.primary_model_id,
        'sonnetModelId', selected_models.primary_model_id,
        'haikuModelId', selected_models.assistant_model_id,
        'enableSmartRouting', true,
        'enableSmartSearchDecision', true,
        'enablePromptCache', false
      )
    )
) AS runtime_model_settings(key, value)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value;

DO $$
DECLARE
  v_plan_id uuid;
BEGIN
  SELECT id
  INTO v_plan_id
  FROM public.membership_plans
  WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000101'::uuid
    OR level = 'pro'
  ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000101'::uuid) DESC, sort_order ASC, created_at ASC
  LIMIT 1;

  IF v_plan_id IS NULL THEN
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
      sort_order
    )
    VALUES (
      '6f3c8d0e-0b2a-4a5d-8d0d-148000000101'::uuid,
      'Staging Pro',
      'pro',
      990,
      9900,
      NULL,
      NULL,
      1500,
      20000,
      0,
      100,
      '["1500 monthly credits", "30 day history", "Standard model access"]'::jsonb,
      30,
      20,
      'true',
      'false',
      'true',
      10
    );
  ELSE
    UPDATE public.membership_plans
    SET
      name = 'Staging Pro',
      level = 'pro',
      monthly_price = 990,
      yearly_price = 9900,
      stripe_monthly_price_id = NULL,
      stripe_yearly_price_id = NULL,
      monthly_credits = 1500,
      yearly_credits = 20000,
      monthly_bonus_credits = 0,
      package_discount = 100,
      features = '["1500 monthly credits", "30 day history", "Standard model access"]'::jsonb,
      history_retention_days = 30,
      max_context_messages = 20,
      allow_export = 'true',
      allow_batch_export = 'false',
      is_active = 'true',
      sort_order = 10,
      updated_at = NOW()
    WHERE id = v_plan_id;
  END IF;
END $$;

DO $$
DECLARE
  v_package_id uuid;
BEGIN
  SELECT id
  INTO v_package_id
  FROM public.credit_packages
  WHERE id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000201'::uuid
    OR name = 'Staging Starter Credits'
  ORDER BY (id = '6f3c8d0e-0b2a-4a5d-8d0d-148000000201'::uuid) DESC, sort_order ASC, created_at ASC
  LIMIT 1;

  IF v_package_id IS NULL THEN
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
    VALUES (
      '6f3c8d0e-0b2a-4a5d-8d0d-148000000201'::uuid,
      'Staging Starter Credits',
      500,
      500,
      0,
      NULL,
      10,
      'false',
      'true'
    );
  ELSE
    UPDATE public.credit_packages
    SET
      name = 'Staging Starter Credits',
      price = 500,
      credits_amount = 500,
      bonus_credits = 0,
      stripe_price_id = NULL,
      sort_order = 10,
      is_popular = 'false',
      active = 'true'
    WHERE id = v_package_id;
  END IF;
END $$;

COMMIT;
