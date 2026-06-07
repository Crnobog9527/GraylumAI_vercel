/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Smoke test for 0042_canceled_subscription_profile_downgrade.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_plan_id UUID := gen_random_uuid();
  v_canceled_subscription_id UUID := gen_random_uuid();
  v_active_subscription_id UUID := gen_random_uuid();
  v_result RECORD;
  v_credits INTEGER;
  v_membership_level TEXT;
BEGIN
  INSERT INTO profiles (id, email, credits, membership_level)
  VALUES (v_user_id, 'subscription-downgrade@example.test', 777, 'pro');

  INSERT INTO membership_plans (id, name, level)
  VALUES (v_plan_id, 'Downgrade Smoke Pro', 'pro');

  INSERT INTO user_subscriptions (
    id,
    user_id,
    membership_plan_id,
    stripe_subscription_id,
    billing_cycle,
    status,
    cancel_at_period_end
  ) VALUES (
    v_canceled_subscription_id,
    v_user_id,
    v_plan_id,
    'sub_downgrade_canceled',
    'monthly',
    'canceled',
    'false'
  );

  SELECT *
  INTO v_result
  FROM public.atomic_downgrade_canceled_subscription_profile('sub_downgrade_canceled');

  IF v_result.subscription_found IS NOT TRUE
    OR v_result.subscription_id <> v_canceled_subscription_id
    OR v_result.user_id <> v_user_id
    OR v_result.profile_updated IS NOT TRUE
    OR v_result.previous_membership_level <> 'pro'
    OR v_result.new_membership_level <> 'free' THEN
    RAISE EXCEPTION 'canceled subscription downgrade assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits, membership_level
  INTO v_credits, v_membership_level
  FROM profiles
  WHERE id = v_user_id;

  IF v_credits <> 777 OR v_membership_level <> 'free' THEN
    RAISE EXCEPTION 'profile downgrade changed unexpected fields: credits %, level %', v_credits, v_membership_level;
  END IF;

  SELECT *
  INTO v_result
  FROM public.atomic_downgrade_canceled_subscription_profile('sub_downgrade_canceled');

  IF v_result.subscription_found IS NOT TRUE
    OR v_result.profile_updated IS NOT FALSE
    OR v_result.previous_membership_level <> 'free'
    OR v_result.new_membership_level <> 'free' THEN
    RAISE EXCEPTION 'idempotent free downgrade assertion failed: %', row_to_json(v_result);
  END IF;

  INSERT INTO user_subscriptions (
    id,
    user_id,
    membership_plan_id,
    stripe_subscription_id,
    billing_cycle,
    status,
    cancel_at_period_end
  ) VALUES (
    v_active_subscription_id,
    v_user_id,
    v_plan_id,
    'sub_downgrade_active',
    'monthly',
    'active',
    'true'
  );

  BEGIN
    PERFORM *
    FROM public.atomic_downgrade_canceled_subscription_profile('sub_downgrade_active');

    RAISE EXCEPTION 'active subscription downgrade unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'subscription sub_downgrade_active is not canceled%' THEN
      RAISE;
    END IF;
  END;

  SELECT *
  INTO v_result
  FROM public.atomic_downgrade_canceled_subscription_profile('sub_downgrade_missing');

  IF v_result.subscription_found IS NOT FALSE
    OR v_result.profile_updated IS NOT FALSE
    OR v_result.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'missing subscription assertion failed: %', row_to_json(v_result);
  END IF;
END;
$$;

DO $$
DECLARE
  v_function TEXT := 'public.atomic_downgrade_canceled_subscription_profile(text)';
BEGIN
  IF has_function_privilege('anon', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute service-only function: %', v_function;
  END IF;

  IF has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute service-only function: %', v_function;
  END IF;

  IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute service-only function: %', v_function;
  END IF;
END;
$$;

ROLLBACK;
