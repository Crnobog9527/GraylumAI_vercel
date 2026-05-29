/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Smoke test for 0041_stripe_refund_reconciliation.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_full_order_id UUID := gen_random_uuid();
  v_partial_order_id UUID := gen_random_uuid();
  v_failed_order_id UUID := gen_random_uuid();
  v_shortfall_order_id UUID := gen_random_uuid();
  v_zero_shortfall_order_id UUID := gen_random_uuid();
  v_missing_credits_order_id UUID := gen_random_uuid();
  v_plan_id UUID := gen_random_uuid();
  v_result RECORD;
  v_credits INTEGER;
  v_transaction_count INTEGER;
  v_order RECORD;
  v_has_privilege BOOLEAN;
BEGIN
  INSERT INTO profiles (id, email, credits, membership_level)
  VALUES (v_user_id, 'stripe-refund-reconcile@example.test', 120, 'pro');

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_invoice_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_full_order_id,
    v_user_id,
    'membership_plan',
    v_plan_id,
    'monthly',
    'in_refund_full',
    990,
    'usd',
    'subscription',
    'completed',
    'paid',
    NOW(),
    jsonb_build_object('grantedCredits', 100)
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_full_order_id,
    'stripe_refund:re_full',
    'refund.created',
    're_full',
    'succeeded',
    990,
    'usd',
    'ch_full',
    'pi_full',
    'in_refund_full',
    'sub_full',
    'requested_by_customer',
    NOW(),
    TRUE,
    FALSE
  );

  IF v_result.order_status <> 'refunded'
    OR v_result.clawback_amount <> 100
    OR v_result.shortfall_amount <> 0
    OR v_result.transaction_id IS NULL
    OR v_result.already_reconciled IS NOT FALSE THEN
    RAISE EXCEPTION 'full refund assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_credits FROM profiles WHERE id = v_user_id;
  IF v_credits <> 20 THEN
    RAISE EXCEPTION 'full refund balance assertion failed: %', v_credits;
  END IF;

  SELECT status, payment_status, metadata
  INTO v_order
  FROM payment_orders
  WHERE id = v_full_order_id;

  IF v_order.status <> 'refunded'
    OR v_order.payment_status <> 'refunded'
    OR v_order.metadata->'stripeRefundReconciliation'->>'refundId' <> 're_full'
    OR v_order.metadata->'stripeRefundReconciliation'->>'clawbackApplied' <> 'true' THEN
    RAISE EXCEPTION 'full refund order metadata assertion failed: %', row_to_json(v_order);
  END IF;

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_full_order_id,
    'stripe_refund:re_full',
    'refund.updated',
    're_full',
    'succeeded',
    990,
    'usd',
    'ch_full',
    'pi_full',
    'in_refund_full',
    'sub_full',
    'requested_by_customer',
    NOW(),
    TRUE,
    FALSE
  );

  IF v_result.already_reconciled IS NOT TRUE THEN
    RAISE EXCEPTION 'duplicate full refund did not report idempotent: %', row_to_json(v_result);
  END IF;

  SELECT COUNT(*)
  INTO v_transaction_count
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'stripe_refund:re_full';

  IF v_transaction_count <> 1 THEN
    RAISE EXCEPTION 'duplicate full refund wrote transaction count: %', v_transaction_count;
  END IF;

  SELECT credits INTO v_credits FROM profiles WHERE id = v_user_id;
  IF v_credits <> 20 THEN
    RAISE EXCEPTION 'duplicate full refund changed balance: %', v_credits;
  END IF;

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_full_order_id,
    'stripe_refund:re_partial_after_full',
    'refund.updated',
    're_partial_after_full',
    'succeeded',
    100,
    'usd',
    'ch_full',
    'pi_full',
    'in_refund_full',
    'sub_full',
    'requested_by_customer',
    NOW(),
    FALSE,
    FALSE
  );

  IF v_result.order_status <> 'refunded'
    OR v_result.clawback_amount <> 100
    OR v_result.shortfall_amount <> 0 THEN
    RAISE EXCEPTION 'partial-after-full refund changed full refund state: %', row_to_json(v_result);
  END IF;

  SELECT status, metadata
  INTO v_order
  FROM payment_orders
  WHERE id = v_full_order_id;

  IF v_order.status <> 'refunded'
    OR v_order.metadata->'stripeRefundReconciliation'->>'refundId' <> 're_full'
    OR v_order.metadata->'lastRefundEvent'->>'refundId' <> 're_partial_after_full' THEN
    RAISE EXCEPTION 'partial-after-full metadata assertion failed: %', row_to_json(v_order);
  END IF;

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_checkout_session_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_partial_order_id,
    v_user_id,
    'credit_package',
    gen_random_uuid(),
    'one_time',
    'cs_refund_partial',
    500,
    'usd',
    'payment',
    'completed',
    'paid',
    NOW(),
    jsonb_build_object('grantedCredits', 50)
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_partial_order_id,
    'stripe_refund:re_partial',
    'refund.created',
    're_partial',
    'succeeded',
    100,
    'usd',
    'ch_partial',
    'pi_partial',
    NULL,
    NULL,
    'requested_by_customer',
    NOW(),
    FALSE,
    FALSE
  );

  IF v_result.order_status <> 'partial_refunded'
    OR v_result.clawback_amount <> 0
    OR v_result.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'partial refund assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_credits FROM profiles WHERE id = v_user_id;
  IF v_credits <> 20 THEN
    RAISE EXCEPTION 'partial refund changed balance: %', v_credits;
  END IF;

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_invoice_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_failed_order_id,
    v_user_id,
    'membership_plan',
    v_plan_id,
    'monthly',
    'in_refund_failed',
    990,
    'usd',
    'subscription',
    'completed',
    'paid',
    NOW(),
    jsonb_build_object('grantedCredits', 80)
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_failed_order_id,
    'stripe_refund:re_failed',
    'refund.failed',
    're_failed',
    'failed',
    990,
    'usd',
    'ch_failed',
    'pi_failed',
    'in_refund_failed',
    'sub_failed',
    'lost_or_stolen_card',
    NOW(),
    FALSE,
    TRUE
  );

  IF v_result.order_status <> 'completed'
    OR v_result.clawback_amount <> 0
    OR v_result.shortfall_amount <> 0
    OR v_result.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'refund.failed assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT status, payment_status, metadata
  INTO v_order
  FROM payment_orders
  WHERE id = v_failed_order_id;

  IF v_order.status <> 'completed'
    OR v_order.payment_status <> 'paid'
    OR v_order.metadata->'lastRefundFailure'->>'refundId' <> 're_failed'
    OR v_order.metadata ? 'stripeRefundReconciliation' THEN
    RAISE EXCEPTION 'refund.failed order metadata assertion failed: %', row_to_json(v_order);
  END IF;

  SELECT credits INTO v_credits FROM profiles WHERE id = v_user_id;
  IF v_credits <> 20 THEN
    RAISE EXCEPTION 'refund.failed changed balance: %', v_credits;
  END IF;

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_invoice_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_missing_credits_order_id,
    v_user_id,
    'membership_plan',
    v_plan_id,
    'monthly',
    'in_refund_missing_credits',
    990,
    'usd',
    'subscription',
    'completed',
    'paid',
    NOW(),
    '{}'::jsonb
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_missing_credits_order_id,
    'stripe_refund:re_missing_credits',
    'refund.created',
    're_missing_credits',
    'succeeded',
    990,
    'usd',
    'ch_missing_credits',
    'pi_missing_credits',
    'in_refund_missing_credits',
    'sub_missing_credits',
    'requested_by_customer',
    NOW(),
    TRUE,
    FALSE
  );

  IF v_result.order_status <> 'refunded'
    OR v_result.clawback_amount <> 0
    OR v_result.shortfall_amount <> 0
    OR v_result.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'missing grantedCredits assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT status, payment_status, metadata
  INTO v_order
  FROM payment_orders
  WHERE id = v_missing_credits_order_id;

  IF v_order.status <> 'refunded'
    OR v_order.payment_status <> 'refunded'
    OR v_order.metadata->'stripeRefundReconciliation'->>'grantedCreditsMetadataGap' <> 'missing_grantedCredits'
    OR v_order.metadata->'stripeRefundReconciliation'->>'grantedCredits' <> '0' THEN
    RAISE EXCEPTION 'missing grantedCredits metadata assertion failed: %', row_to_json(v_order);
  END IF;

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_invoice_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_shortfall_order_id,
    v_user_id,
    'membership_plan',
    v_plan_id,
    'monthly',
    'in_refund_shortfall',
    990,
    'usd',
    'subscription',
    'completed',
    'paid',
    NOW(),
    jsonb_build_object('grantedCredits', 80)
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_shortfall_order_id,
    'stripe_refund:re_shortfall',
    'charge.refunded',
    're_shortfall',
    'succeeded',
    990,
    'usd',
    'ch_shortfall',
    'pi_shortfall',
    'in_refund_shortfall',
    'sub_shortfall',
    'requested_by_customer',
    NOW(),
    TRUE,
    FALSE
  );

  IF v_result.clawback_amount <> 20
    OR v_result.shortfall_amount <> 60 THEN
    RAISE EXCEPTION 'shortfall refund assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_credits FROM profiles WHERE id = v_user_id;
  IF v_credits <> 0 THEN
    RAISE EXCEPTION 'shortfall refund balance assertion failed: %', v_credits;
  END IF;

  INSERT INTO payment_orders (
    id,
    user_id,
    item_type,
    item_id,
    billing_cycle,
    stripe_invoice_id,
    amount_total,
    currency,
    mode,
    status,
    payment_status,
    fulfilled_at,
    metadata
  ) VALUES (
    v_zero_shortfall_order_id,
    v_user_id,
    'membership_plan',
    v_plan_id,
    'monthly',
    'in_refund_zero_shortfall',
    990,
    'usd',
    'subscription',
    'completed',
    'paid',
    NOW(),
    jsonb_build_object('grantedCredits', 40)
  );

  SELECT *
  INTO v_result
  FROM public.atomic_reconcile_stripe_refund(
    v_zero_shortfall_order_id,
    'stripe_refund:re_zero_shortfall',
    'refund.created',
    're_zero_shortfall',
    'succeeded',
    990,
    'usd',
    'ch_zero_shortfall',
    'pi_zero_shortfall',
    'in_refund_zero_shortfall',
    'sub_zero_shortfall',
    'requested_by_customer',
    NOW(),
    TRUE,
    FALSE
  );

  IF v_result.clawback_amount <> 0
    OR v_result.shortfall_amount <> 40
    OR v_result.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'zero-balance shortfall assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT COUNT(*)
  INTO v_transaction_count
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'stripe_refund:re_zero_shortfall';

  IF v_transaction_count <> 0 THEN
    RAISE EXCEPTION 'zero-balance shortfall wrote zero transaction count: %', v_transaction_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM payment_orders
    WHERE status IN ('refunded', 'partial_refunded')
  ) THEN
    RAISE EXCEPTION 'refund status CHECK assertion did not observe new statuses';
  END IF;

  SELECT COALESCE(bool_or(has_function_privilege(
    r.rolname,
    'public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamp with time zone,boolean,boolean)',
    'EXECUTE'
  )), FALSE)
  INTO v_has_privilege
  FROM pg_roles AS r
  WHERE r.rolname IN ('anon', 'authenticated');

  IF v_has_privilege THEN
    RAISE EXCEPTION 'anon/authenticated unexpectedly have refund RPC EXECUTE privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
    AND NOT has_function_privilege(
      'service_role',
      'public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamp with time zone,boolean,boolean)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'service_role is missing refund RPC EXECUTE privilege';
  END IF;
END;
$$;

ROLLBACK;
