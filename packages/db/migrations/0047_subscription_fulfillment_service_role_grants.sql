/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: subscription fulfillment service-role grants
-- Description:
--   Forward-only posture repair for PR #255 paid membership checkout
--   fulfillment. Restores only the service-role grants required by the
--   subscription credit grant path, keeps profile credit writes behind the
--   atomic ledger RPC, and keeps browser/client roles closed for payment,
--   subscription, grant, and ledger writes. Source only: do not apply to
--   staging or production without separate owner approval.

DO $$
DECLARE
  v_missing_objects TEXT[];
BEGIN
  SELECT array_agg(object_name ORDER BY object_name)
  INTO v_missing_objects
  FROM (
    VALUES
      ('public.profiles', to_regclass('public.profiles')),
      ('public.payment_orders', to_regclass('public.payment_orders')),
      ('public.user_subscriptions', to_regclass('public.user_subscriptions')),
      ('public.subscription_credit_grants', to_regclass('public.subscription_credit_grants')),
      ('public.credit_transactions', to_regclass('public.credit_transactions'))
  ) AS required(object_name, object_regclass)
  WHERE object_regclass IS NULL;

  IF v_missing_objects IS NOT NULL THEN
    RAISE EXCEPTION
      '0047_subscription_fulfillment_service_role_grants requires missing objects: %',
      array_to_string(v_missing_objects, ', ');
  END IF;

  IF to_regprocedure('public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION
      '0047_subscription_fulfillment_service_role_grants requires public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)';
  END IF;
END $$;

-- Browser/client roles must not receive new write paths for fulfillment data.
-- Profile credits remain ledger/RPC-only, and membership upgrades remain
-- server-side service-role work.
REVOKE UPDATE (membership_level, credits) ON TABLE public.profiles FROM PUBLIC;
REVOKE UPDATE (membership_level, credits) ON TABLE public.profiles FROM anon;
REVOKE UPDATE (membership_level, credits) ON TABLE public.profiles FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.subscription_credit_grants FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.subscription_credit_grants FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.subscription_credit_grants FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payment_orders FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_subscriptions FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM authenticated;

REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;

-- PR #255 / subscriptionCreditGrants.ts syncs only the membership level on the
-- profile. It does not update profiles.updated_at, and it must not directly
-- update profiles.credits.
GRANT SELECT (id) ON TABLE public.profiles TO service_role;
GRANT UPDATE (membership_level) ON TABLE public.profiles TO service_role;

-- The existing checkout posture migration already grants service_role
-- payment_orders and user_subscriptions table DML. Only repair those named
-- table surfaces if an environment is missing the established 0034 posture.
DO $$
BEGIN
  IF NOT (
    has_table_privilege('service_role', 'public.payment_orders', 'SELECT')
    AND has_table_privilege('service_role', 'public.payment_orders', 'INSERT')
    AND has_table_privilege('service_role', 'public.payment_orders', 'UPDATE')
  ) THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_orders TO service_role;
  END IF;

  IF NOT (
    has_table_privilege('service_role', 'public.user_subscriptions', 'SELECT')
    AND has_table_privilege('service_role', 'public.user_subscriptions', 'INSERT')
    AND has_table_privilege('service_role', 'public.user_subscriptions', 'UPDATE')
  ) THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.user_subscriptions TO service_role;
  END IF;
END $$;

-- Subscription credit grants are written by the service-role fulfillment path.
-- UPDATE is intentionally column-scoped to refund/reversal lifecycle metadata.
GRANT SELECT (
  id,
  user_id,
  membership_plan_id,
  stripe_subscription_id,
  stripe_invoice_id,
  billing_cycle,
  grant_type,
  grant_period_key,
  period_index,
  credits_granted,
  status,
  idempotency_key,
  credit_transaction_id,
  metadata
) ON TABLE public.subscription_credit_grants TO service_role;

GRANT INSERT (
  user_id,
  membership_plan_id,
  stripe_subscription_id,
  stripe_invoice_id,
  billing_cycle,
  grant_type,
  grant_period_key,
  period_start,
  period_end,
  period_index,
  total_periods,
  credits_granted,
  status,
  idempotency_key,
  credit_transaction_id,
  metadata
) ON TABLE public.subscription_credit_grants TO service_role;

GRANT UPDATE (
  status,
  updated_at,
  metadata
) ON TABLE public.subscription_credit_grants TO service_role;

-- The credit balance and ledger row are created through the service-only RPC.
-- Direct credit_transactions INSERT stays closed; the service updates only
-- semantic audit columns on the RPC-created row.
GRANT SELECT (
  id,
  amount,
  user_id,
  idempotency_key,
  balance_after
) ON TABLE public.credit_transactions TO service_role;

GRANT UPDATE (
  ledger_type,
  reason_code,
  counts_as_spend,
  source_type,
  source_id,
  source_order_id,
  source_refund_id,
  grant_period_key,
  metadata
) ON TABLE public.credit_transactions TO service_role;

GRANT EXECUTE ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;
