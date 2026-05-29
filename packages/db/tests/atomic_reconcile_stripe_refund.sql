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
  v_shortfall_order_id UUID := gen_random_uuid();
  v_plan_id UUID := gen_random_uuid();
  v_result RECORD;
  v_credits INTEGER;
  v_transaction_count INTEGER;
  v_order RECORD;
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
END;
$$;

ROLLBACK;
