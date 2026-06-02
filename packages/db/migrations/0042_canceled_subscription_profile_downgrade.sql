/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: canceled subscription profile downgrade
-- Description:
--   Adds a service-role-only RPC that atomically downgrades the profile tied
--   to a canceled Stripe subscription. This keeps customer.subscription.deleted
--   webhook handling retryable if paid entitlement recovery cannot be confirmed.
--   Do not apply to staging or production without explicit owner approval.

CREATE OR REPLACE FUNCTION public.atomic_downgrade_canceled_subscription_profile(
  p_stripe_subscription_id TEXT
)
RETURNS TABLE (
  stripe_subscription_id TEXT,
  subscription_id UUID,
  subscription_found BOOLEAN,
  user_id UUID,
  profile_updated BOOLEAN,
  previous_membership_level TEXT,
  new_membership_level TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_subscription_id UUID;
  v_user_id UUID;
  v_subscription_status TEXT;
  v_previous_membership_level TEXT;
  v_new_membership_level TEXT;
  v_profile_updated BOOLEAN := FALSE;
BEGIN
  IF p_stripe_subscription_id IS NULL OR btrim(p_stripe_subscription_id) = '' THEN
    RAISE EXCEPTION 'stripe_subscription_id is required';
  END IF;

  SELECT us.id, us.user_id, us.status
  INTO v_subscription_id, v_user_id, v_subscription_status
  FROM public.user_subscriptions AS us
  WHERE us.stripe_subscription_id = p_stripe_subscription_id
  FOR UPDATE OF us;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_stripe_subscription_id,
      NULL::UUID,
      FALSE,
      NULL::UUID,
      FALSE,
      NULL::TEXT,
      NULL::TEXT;
    RETURN;
  END IF;

  IF v_subscription_status <> 'canceled' THEN
    RAISE EXCEPTION 'subscription % is not canceled', p_stripe_subscription_id;
  END IF;

  SELECT p.membership_level
  INTO v_previous_membership_level
  FROM public.profiles AS p
  WHERE p.id = v_user_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for canceled subscription %', p_stripe_subscription_id;
  END IF;

  IF v_previous_membership_level IS DISTINCT FROM 'free' THEN
    UPDATE public.profiles
    SET membership_level = 'free'
    WHERE id = v_user_id
    RETURNING membership_level INTO v_new_membership_level;

    v_profile_updated := TRUE;
  ELSE
    v_new_membership_level := v_previous_membership_level;
  END IF;

  RETURN QUERY SELECT
    p_stripe_subscription_id,
    v_subscription_id,
    TRUE,
    v_user_id,
    v_profile_updated,
    v_previous_membership_level,
    v_new_membership_level;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_downgrade_canceled_subscription_profile(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_downgrade_canceled_subscription_profile(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_downgrade_canceled_subscription_profile(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_downgrade_canceled_subscription_profile(TEXT) TO service_role;

COMMENT ON FUNCTION public.atomic_downgrade_canceled_subscription_profile(TEXT)
IS 'Atomically downgrades the profile for a canceled Stripe subscription. Service-role only.';
