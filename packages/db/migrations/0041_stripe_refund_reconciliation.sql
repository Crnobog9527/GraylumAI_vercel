/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: Stripe refund reconciliation
-- Description:
--   Adds payment order refund states and a service-role-only RPC for
--   idempotent Stripe refund entitlement reconciliation.
--   Do not apply to staging or production without explicit owner approval.

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_status_check;

ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'refunded', 'partial_refunded'));

CREATE OR REPLACE FUNCTION public.atomic_reconcile_stripe_refund(
  p_order_id UUID,
  p_idempotency_key TEXT,
  p_refund_event_type TEXT,
  p_refund_id TEXT DEFAULT NULL,
  p_refund_status TEXT DEFAULT NULL,
  p_refund_amount INTEGER DEFAULT NULL,
  p_refund_currency TEXT DEFAULT NULL,
  p_charge_id TEXT DEFAULT NULL,
  p_payment_intent_id TEXT DEFAULT NULL,
  p_invoice_id TEXT DEFAULT NULL,
  p_subscription_id TEXT DEFAULT NULL,
  p_refund_reason TEXT DEFAULT NULL,
  p_refund_created_at TIMESTAMPTZ DEFAULT NULL,
  p_is_full_refund BOOLEAN DEFAULT FALSE,
  p_is_failed BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  order_id UUID,
  user_id UUID,
  order_status TEXT,
  clawback_amount INTEGER,
  shortfall_amount INTEGER,
  transaction_id UUID,
  already_reconciled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id UUID;
  v_user_id UUID;
  v_existing_status TEXT;
  v_metadata JSONB;
  v_granted_credits INTEGER := 0;
  v_existing_transaction RECORD;
  v_transaction_id UUID;
  v_balance_before INTEGER := NULL;
  v_balance_after INTEGER := NULL;
  v_clawback_amount INTEGER := 0;
  v_shortfall_amount INTEGER := 0;
  v_now TIMESTAMPTZ := NOW();
  v_idempotency_key TEXT;
  v_refund_info JSONB;
  v_granted_credits_gap TEXT := NULL;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id is required';
  END IF;

  IF p_refund_event_type IS NULL OR btrim(p_refund_event_type) = '' THEN
    RAISE EXCEPTION 'refund event type is required';
  END IF;

  v_idempotency_key := COALESCE(
    NULLIF(btrim(p_idempotency_key), ''),
    format(
      'stripe_refund:%s:%s:%s',
      COALESCE(NULLIF(p_refund_id, ''), NULLIF(p_charge_id, ''), NULLIF(p_payment_intent_id, ''), p_order_id::TEXT),
      COALESCE(p_refund_amount, 0),
      p_refund_event_type
    )
  );

  SELECT po.id, po.user_id, po.status, po.metadata
  INTO v_order_id, v_user_id, v_existing_status, v_metadata
  FROM public.payment_orders AS po
  WHERE po.id = p_order_id
  FOR UPDATE OF po;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found for refund reconciliation: %', p_order_id;
  END IF;

  v_metadata := COALESCE(v_metadata, '{}'::jsonb);
  IF NOT v_metadata ? 'grantedCredits' THEN
    v_granted_credits := 0;
    v_granted_credits_gap := 'missing_grantedCredits';
  ELSIF COALESCE(v_metadata->>'grantedCredits', '') ~ '^-?[0-9]+$' THEN
    v_granted_credits := GREATEST((v_metadata->>'grantedCredits')::INTEGER, 0);
  ELSE
    v_granted_credits := 0;
    v_granted_credits_gap := 'invalid_grantedCredits';
  END IF;

  v_refund_info := jsonb_strip_nulls(jsonb_build_object(
    'refundId', p_refund_id,
    'eventType', p_refund_event_type,
    'refundStatus', p_refund_status,
    'chargeId', p_charge_id,
    'paymentIntentId', p_payment_intent_id,
    'invoiceId', p_invoice_id,
    'subscriptionId', p_subscription_id,
    'amountRefunded', p_refund_amount,
    'currency', p_refund_currency,
    'reason', p_refund_reason,
    'refundCreatedAt', p_refund_created_at,
    'reconciledAt', v_now,
    'source', 'atomic_reconcile_stripe_refund',
    'idempotencyKey', v_idempotency_key,
    'grantedCreditsMetadataGap', v_granted_credits_gap,
    'fullRefund', p_is_full_refund,
    'failed', p_is_failed
  ));

  IF p_is_failed THEN
    UPDATE public.payment_orders AS po
    SET
      updated_at = v_now,
      metadata = v_metadata || jsonb_build_object(
        'lastRefundFailure', v_refund_info,
        'refundReconciliationSource', 'atomic_reconcile_stripe_refund'
      )
    WHERE po.id = v_order_id;

    RETURN QUERY SELECT v_order_id, v_user_id, v_existing_status, 0, 0, NULL::UUID, FALSE;
    RETURN;
  END IF;

  IF NOT p_is_full_refund AND v_existing_status = 'refunded' THEN
    UPDATE public.payment_orders AS po
    SET
      updated_at = v_now,
      metadata = v_metadata || jsonb_build_object(
        'lastRefundEvent', v_refund_info,
        'refundReconciliationSource', 'atomic_reconcile_stripe_refund'
      )
    WHERE po.id = v_order_id;

    RETURN QUERY SELECT
      v_order_id,
      v_user_id,
      v_existing_status,
      COALESCE(NULLIF(v_metadata->'stripeRefundReconciliation'->>'clawbackAmount', '')::INTEGER, 0),
      COALESCE(NULLIF(v_metadata->'stripeRefundReconciliation'->>'shortfallAmount', '')::INTEGER, 0),
      NULLIF(v_metadata->'stripeRefundReconciliation'->>'clawbackTransactionId', '')::UUID,
      FALSE;
    RETURN;
  END IF;

  IF p_is_full_refund
    AND v_existing_status = 'refunded'
    AND COALESCE(v_metadata->'stripeRefundReconciliation'->>'clawbackApplied', 'false') = 'true'
  THEN
    RETURN QUERY SELECT
      v_order_id,
      v_user_id,
      v_existing_status,
      COALESCE(NULLIF(v_metadata->'stripeRefundReconciliation'->>'clawbackAmount', '')::INTEGER, 0),
      COALESCE(NULLIF(v_metadata->'stripeRefundReconciliation'->>'shortfallAmount', '')::INTEGER, 0),
      NULLIF(v_metadata->'stripeRefundReconciliation'->>'clawbackTransactionId', '')::UUID,
      TRUE;
    RETURN;
  END IF;

  IF p_is_full_refund AND v_user_id IS NOT NULL AND v_granted_credits > 0 THEN
    SELECT ct.id, ct.amount, ct.balance_before, ct.balance_after
    INTO v_existing_transaction
    FROM public.credit_transactions AS ct
    WHERE ct.user_id = v_user_id
      AND ct.idempotency_key = v_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      v_transaction_id := v_existing_transaction.id;
      v_clawback_amount := ABS(COALESCE(v_existing_transaction.amount, 0));
      v_balance_before := v_existing_transaction.balance_before;
      v_balance_after := v_existing_transaction.balance_after;
      v_shortfall_amount := GREATEST(v_granted_credits - v_clawback_amount, 0);
    ELSE
      SELECT p.credits
      INTO v_balance_before
      FROM public.profiles AS p
      WHERE p.id = v_user_id
      FOR UPDATE OF p;

      IF FOUND THEN
        v_clawback_amount := LEAST(GREATEST(v_balance_before, 0), v_granted_credits);
        v_shortfall_amount := GREATEST(v_granted_credits - v_clawback_amount, 0);
        v_balance_after := GREATEST(v_balance_before - v_clawback_amount, 0);

        IF v_balance_after <> v_balance_before THEN
          UPDATE public.profiles AS p
          SET credits = v_balance_after
          WHERE p.id = v_user_id;
        END IF;

        IF v_clawback_amount > 0 THEN
          INSERT INTO public.credit_transactions (
            user_id,
            amount,
            type,
            description,
            idempotency_key,
            balance_before,
            balance_after
          ) VALUES (
            v_user_id,
            -v_clawback_amount,
            'deduction',
            format(
              'Stripe refund credit clawback [order:%s refund:%s shortfall:%s]',
              v_order_id,
              COALESCE(p_refund_id, p_charge_id, v_idempotency_key),
              v_shortfall_amount
            ),
            v_idempotency_key,
            v_balance_before,
            v_balance_after
          )
          RETURNING credit_transactions.id INTO v_transaction_id;
        END IF;
      ELSE
        v_shortfall_amount := v_granted_credits;
      END IF;
    END IF;
  ELSIF p_is_full_refund AND v_granted_credits > 0 THEN
    v_shortfall_amount := v_granted_credits;
  END IF;

  v_refund_info := v_refund_info || jsonb_build_object(
    'grantedCredits', v_granted_credits,
    'clawbackAmount', v_clawback_amount,
    'shortfallAmount', v_shortfall_amount,
    'balanceBefore', v_balance_before,
    'balanceAfter', v_balance_after,
    'clawbackTransactionId', v_transaction_id,
    'clawbackApplied', p_is_full_refund
  );

  UPDATE public.payment_orders AS po
  SET
    status = CASE WHEN p_is_full_refund THEN 'refunded' ELSE 'partial_refunded' END,
    payment_status = CASE WHEN p_is_full_refund THEN 'refunded' ELSE 'partial_refunded' END,
    updated_at = v_now,
    metadata = v_metadata || jsonb_build_object(
      'stripeRefundReconciliation', v_refund_info,
      'refundReconciliationSource', 'atomic_reconcile_stripe_refund'
    )
  WHERE po.id = v_order_id;

  RETURN QUERY SELECT
    v_order_id,
    v_user_id,
    CASE WHEN p_is_full_refund THEN 'refunded' ELSE 'partial_refunded' END,
    v_clawback_amount,
    v_shortfall_amount,
    v_transaction_id,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.atomic_reconcile_stripe_refund(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_reconcile_stripe_refund(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_reconcile_stripe_refund(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_stripe_refund(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN
) TO service_role;

COMMENT ON FUNCTION public.atomic_reconcile_stripe_refund(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN
) IS 'Atomically records Stripe refund status and idempotently claws back granted credits for full refunds.';
