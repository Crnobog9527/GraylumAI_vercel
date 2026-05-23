/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: preserve subscription status on invoice fulfillment
-- Description:
--   Keep user_subscriptions.status aligned to Stripe subscription lifecycle
--   status instead of overwriting it with invoice payment status such as paid.
--   Invoice payment status remains stored on payment_orders.payment_status.

CREATE OR REPLACE FUNCTION public.atomic_fulfill_membership_invoice(
  p_invoice_id TEXT,
  p_subscription_id TEXT,
  p_amount_total INTEGER,
  p_currency TEXT DEFAULT 'usd',
  p_payment_status TEXT DEFAULT 'paid',
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_period_end TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  invoice_order_id UUID,
  user_id UUID,
  granted_credits INTEGER,
  fulfilled_at TIMESTAMPTZ,
  already_fulfilled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice_order_id UUID;
  v_existing_fulfilled_at TIMESTAMPTZ;
  v_invoice_metadata JSONB;
  v_session_order_user_id UUID;
  v_session_order_item_id UUID;
  v_session_order_billing_cycle TEXT;
  v_session_order_customer_id TEXT;
  v_session_order_price_id TEXT;
  v_plan_id UUID;
  v_plan_name TEXT;
  v_plan_level TEXT;
  v_monthly_credits INTEGER;
  v_yearly_credits INTEGER;
  v_monthly_bonus_credits INTEGER;
  v_granted_credits INTEGER;
  v_transaction_id UUID;
  v_fulfilled_at TIMESTAMPTZ;
BEGIN
  SELECT po.id, po.fulfilled_at, po.metadata
  INTO v_invoice_order_id, v_existing_fulfilled_at, v_invoice_metadata
  FROM payment_orders AS po
  WHERE po.stripe_invoice_id = p_invoice_id
  FOR UPDATE OF po;

  IF FOUND AND v_existing_fulfilled_at IS NOT NULL THEN
    SELECT po.user_id INTO v_session_order_user_id
    FROM payment_orders AS po
    WHERE po.id = v_invoice_order_id;

    RETURN QUERY SELECT v_invoice_order_id, v_session_order_user_id, 0, v_existing_fulfilled_at, TRUE;
    RETURN;
  END IF;

  SELECT po.user_id, po.item_id, po.billing_cycle, po.stripe_customer_id, po.stripe_price_id
  INTO v_session_order_user_id, v_session_order_item_id, v_session_order_billing_cycle, v_session_order_customer_id, v_session_order_price_id
  FROM payment_orders AS po
  WHERE po.stripe_subscription_id = p_subscription_id
  ORDER BY po.created_at DESC
  LIMIT 1
  FOR UPDATE OF po;

  IF NOT FOUND OR v_session_order_user_id IS NULL OR v_session_order_item_id IS NULL THEN
    RAISE EXCEPTION 'subscription order not found for invoice %', p_invoice_id;
  END IF;

  SELECT mp.id, mp.name, mp.level, mp.monthly_credits, mp.yearly_credits, mp.monthly_bonus_credits
  INTO v_plan_id, v_plan_name, v_plan_level, v_monthly_credits, v_yearly_credits, v_monthly_bonus_credits
  FROM membership_plans AS mp
  WHERE mp.id = v_session_order_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership plan not found for invoice %', p_invoice_id;
  END IF;

  PERFORM 1
  FROM profiles AS p
  WHERE p.id = v_session_order_user_id
  FOR UPDATE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for invoice %', p_invoice_id;
  END IF;

  v_session_order_billing_cycle := CASE
    WHEN v_session_order_billing_cycle = 'yearly' THEN 'yearly'
    ELSE 'monthly'
  END;

  v_granted_credits := CASE
    WHEN v_session_order_billing_cycle = 'yearly' THEN COALESCE(v_yearly_credits, 0)
    ELSE COALESCE(v_monthly_credits, 0) + COALESCE(v_monthly_bonus_credits, 0)
  END;

  v_fulfilled_at := NOW();

  UPDATE profiles AS p
  SET
    membership_level = v_plan_level,
    credits = p.credits + v_granted_credits
  WHERE p.id = v_session_order_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description
  ) VALUES (
    v_session_order_user_id,
    v_granted_credits,
    'addition',
    format(
      'Stripe 会员积分到账: %s (%s) [invoice:%s]',
      v_plan_name,
      CASE WHEN v_session_order_billing_cycle = 'yearly' THEN '年付' ELSE '月付' END,
      p_invoice_id
    )
  )
  RETURNING credit_transactions.id INTO v_transaction_id;

  UPDATE user_subscriptions AS us
  SET
    user_id = v_session_order_user_id,
    membership_plan_id = v_plan_id,
    stripe_customer_id = COALESCE(v_session_order_customer_id, p_stripe_customer_id),
    stripe_price_id = v_session_order_price_id,
    billing_cycle = v_session_order_billing_cycle,
    status = COALESCE(NULLIF(us.status, ''), 'active'),
    cancel_at_period_end = 'false',
    current_period_start = p_period_start,
    current_period_end = p_period_end,
    metadata = COALESCE(us.metadata, '{}'::jsonb) || jsonb_build_object(
      'lastInvoiceId', p_invoice_id,
      'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
      'transactionId', v_transaction_id,
      'fulfillmentSource', 'atomic_fulfill_membership_invoice'
    ),
    updated_at = v_fulfilled_at
  WHERE us.stripe_subscription_id = p_subscription_id;

  IF NOT FOUND THEN
    INSERT INTO user_subscriptions (
      user_id,
      membership_plan_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      billing_cycle,
      status,
      cancel_at_period_end,
      current_period_start,
      current_period_end,
      metadata,
      updated_at
    ) VALUES (
      v_session_order_user_id,
      v_plan_id,
      COALESCE(v_session_order_customer_id, p_stripe_customer_id),
      p_subscription_id,
      v_session_order_price_id,
      v_session_order_billing_cycle,
      'active',
      'false',
      p_period_start,
      p_period_end,
      jsonb_build_object(
        'lastInvoiceId', p_invoice_id,
        'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
        'transactionId', v_transaction_id,
        'fulfillmentSource', 'atomic_fulfill_membership_invoice'
      ),
      v_fulfilled_at
    );
  END IF;

  IF v_invoice_order_id IS NOT NULL THEN
    UPDATE payment_orders AS po
    SET
      user_id = v_session_order_user_id,
      item_type = 'membership_plan',
      item_id = v_plan_id,
      billing_cycle = v_session_order_billing_cycle,
      stripe_subscription_id = p_subscription_id,
      stripe_customer_id = COALESCE(v_session_order_customer_id, p_stripe_customer_id),
      stripe_price_id = v_session_order_price_id,
      amount_total = p_amount_total,
      currency = COALESCE(p_currency, 'usd'),
      mode = 'subscription',
      status = 'completed',
      payment_status = COALESCE(p_payment_status, 'paid'),
      fulfilled_at = v_fulfilled_at,
      updated_at = v_fulfilled_at,
      metadata = COALESCE(v_invoice_metadata, '{}'::jsonb) || jsonb_build_object(
        'transactionId', v_transaction_id,
        'grantedCredits', v_granted_credits,
        'fulfillmentSource', 'atomic_fulfill_membership_invoice'
      )
    WHERE po.id = v_invoice_order_id;
  ELSE
    INSERT INTO payment_orders (
      user_id,
      item_type,
      item_id,
      billing_cycle,
      stripe_invoice_id,
      stripe_subscription_id,
      stripe_customer_id,
      stripe_price_id,
      amount_total,
      currency,
      mode,
      status,
      payment_status,
      fulfilled_at,
      metadata,
      updated_at
    ) VALUES (
      v_session_order_user_id,
      'membership_plan',
      v_plan_id,
      v_session_order_billing_cycle,
      p_invoice_id,
      p_subscription_id,
      COALESCE(v_session_order_customer_id, p_stripe_customer_id),
      v_session_order_price_id,
      p_amount_total,
      COALESCE(p_currency, 'usd'),
      'subscription',
      'completed',
      COALESCE(p_payment_status, 'paid'),
      v_fulfilled_at,
      jsonb_build_object(
        'source', 'invoice.payment_succeeded',
        'transactionId', v_transaction_id,
        'grantedCredits', v_granted_credits,
        'fulfillmentSource', 'atomic_fulfill_membership_invoice'
      ),
      v_fulfilled_at
    )
    RETURNING payment_orders.id INTO v_invoice_order_id;
  END IF;

  RETURN QUERY SELECT v_invoice_order_id, v_session_order_user_id, v_granted_credits, v_fulfilled_at, FALSE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_membership_invoice(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
