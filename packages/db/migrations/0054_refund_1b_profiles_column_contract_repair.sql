/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: REFUND-1B 0054 forward profiles column-contract repair
-- Description:
--   Rebuild exactly the three 0053 RPCs whose profiles UPDATE targets a
--   non-existent updated_at column. This migration deliberately does not
--   change the profiles schema or any other database object.

CREATE OR REPLACE FUNCTION public.atomic_refund_termination_clawback(
  p_user_id UUID,
  p_subscription_id TEXT,
  p_event_id TEXT,
  p_period_key TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'stripe_refund',
  p_termination_only BOOLEAN DEFAULT FALSE,
  p_refund_id TEXT DEFAULT NULL,
  p_now TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_after INTEGER,
  clawback_amount INTEGER,
  applied_clawback_amount INTEGER,
  shortfall_amount INTEGER,
  already_applied BOOLEAN,
  termination_written BOOLEAN,
  already_terminated BOOLEAN,
  grant_reversed BOOLEAN,
  already_reversed BOOLEAN,
  credits_granted INTEGER,
  consumed_amount INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_full_mode BOOLEAN;
  v_termination_written BOOLEAN := FALSE;
  v_balance_before INTEGER;
  v_mirror_id UUID;
  v_grant_id UUID;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_clawback INTEGER := 0;
  v_applied INTEGER := 0;
  v_shortfall INTEGER := 0;
  v_transaction_id UUID;
  v_existing_transaction RECORD;
  v_existing_termination_at TIMESTAMPTZ;
BEGIN
  IF btrim(COALESCE(p_subscription_id, '')) = '' THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_USER_REQUIRED';
  END IF;

  -- R2/R8: every mode binds the profile and the subscription mirror before
  -- any termination or grant mutation; the profile lock remains first.
  SELECT credits INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_PROFILE_MISSING: %', p_user_id;
  END IF;

  v_full_mode := (p_termination_only IS NOT TRUE) AND (btrim(COALESCE(p_period_key, '')) <> '');

  IF v_full_mode THEN
    IF btrim(COALESCE(p_idempotency_key, '')) = '' THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_CANONICAL_IDEMPOTENCY_KEY_REQUIRED';
    END IF;

    -- R1: 持锁后复查 canonical (event_id + subscription_id + period_key) 幂等键;
    --     唯一索引 idx_credit_transactions_user_idempotency_key 是最终硬屏障
    SELECT ct.id,
           ct.balance_before,
           ct.balance_after,
           COALESCE(NULLIF(ct.metadata->>'requiredClawbackAmount', '')::INTEGER, ABS(ct.amount))
             AS required_amount,
           COALESCE(NULLIF(ct.metadata->>'appliedClawbackAmount', '')::INTEGER, ABS(ct.amount))
             AS applied_amount,
           COALESCE(NULLIF(ct.metadata->>'shortfallAmount', '')::INTEGER, 0)
             AS shortfall_amount
    INTO v_existing_transaction
    FROM credit_transactions AS ct
    WHERE ct.user_id = p_user_id
      AND ct.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_transaction.id,
        v_existing_transaction.balance_after,
        v_existing_transaction.required_amount,
        v_existing_transaction.applied_amount,
        v_existing_transaction.shortfall_amount,
        TRUE,
        FALSE,
        FALSE,
        TRUE,
        FALSE,
        NULL::INTEGER,
        NULL::INTEGER;
      RETURN;
    END IF;
  END IF;

  -- R5: 先写 termination (首个成功事件确立); mirror 缺失即失败关闭,
  --     不得继续 grant reversal / clawback
  -- R8: lock the mirror for the same owner/subscription before writing its
  -- termination marker; a mismatched owner's mirror is not a valid binding.
  SELECT id, credit_release_terminated_at
  INTO v_mirror_id, v_existing_termination_at
  FROM user_subscriptions
  WHERE stripe_subscription_id = p_subscription_id
    AND user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING: %', p_subscription_id;
  END IF;

  IF v_existing_termination_at IS NULL THEN
    UPDATE user_subscriptions
    SET credit_release_terminated_at = v_now,
        credit_release_terminated_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'stripe_refund'),
        credit_release_terminated_event_id = p_event_id,
        credit_release_terminated_period_key = p_period_key,
        updated_at = v_now
    WHERE id = v_mirror_id
      AND credit_release_terminated_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_TERMINATION_WRITE_MISS: %', p_subscription_id;
    END IF;

    v_termination_written := TRUE;
  END IF;

  -- REVIEW_REQUIRED / termination-only: 只停止未来释放, 不猜测扣款
  IF NOT v_full_mode THEN
    RETURN QUERY SELECT
      NULL::UUID,
      NULL::INTEGER,
      0,
      0,
      0,
      FALSE,
      v_termination_written,
      (NOT v_termination_written),
      FALSE,
      FALSE,
      NULL::INTEGER,
      NULL::INTEGER;
    RETURN;
  END IF;

  -- 后续事件不得重复扣款 (首个成功事件已确立 termination 并完成其扣款)
  IF NOT v_termination_written THEN
    RETURN QUERY SELECT
      NULL::UUID,
      v_balance_before,
      0,
      0,
      0,
      FALSE,
      FALSE,
      TRUE,
      FALSE,
      FALSE,
      NULL::INTEGER,
      NULL::INTEGER;
    RETURN;
  END IF;

  -- R8: 持锁 (profile 已锁) 定位周期 grant; 缺失/状态异常即失败关闭
  SELECT g.id, g.status, g.credits_granted, g.consumed_amount
  INTO v_grant_id, v_grant_status, v_grant_granted, v_grant_consumed
  FROM subscription_credit_grants AS g
  JOIN user_subscriptions AS us
    ON us.id = v_mirror_id
   AND us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id
    AND g.stripe_subscription_id = p_subscription_id
    AND g.grant_period_key = p_period_key
  ORDER BY g.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_MISSING: % / %', p_subscription_id, p_period_key;
  END IF;

  IF v_grant_status NOT IN ('granted', 'reversed') THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_UNEXPECTED_STATUS: % (%)', p_period_key, v_grant_status;
  END IF;

  IF v_grant_status = 'reversed' THEN
    -- 该周期已被先前尝试反转: 不重复扣
    RETURN QUERY SELECT
      NULL::UUID,
      v_balance_before,
      0,
      0,
      0,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      TRUE,
      v_grant_granted,
      v_grant_consumed;
    RETURN;
  END IF;

  UPDATE subscription_credit_grants
  SET status = 'reversed',
      updated_at = v_now,
      metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'reversal',
        jsonb_build_object(
          'refundId', p_refund_id,
          'eventId', p_event_id,
          'subscriptionId', p_subscription_id,
          'periodKey', p_period_key,
          'idempotencyKey', p_idempotency_key,
          'reversedAt', v_now,
          'source', 'subscription_refund'
        )
      )
  WHERE id = v_grant_id
    AND status = 'granted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_REVERSAL_RACE: %', p_period_key;
  END IF;

  -- clawback = granted - consumed (持锁值); 以当前余额封顶, 绝不为负
  v_clawback := GREATEST(v_grant_granted - v_grant_consumed, 0);
  v_applied := LEAST(v_clawback, v_balance_before);
  v_shortfall := v_clawback - v_applied;

  IF v_applied > 0 THEN
    UPDATE profiles
    SET credits = v_balance_before - v_applied
    WHERE id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_PROFILE_UPDATE_MISS: %', p_user_id;
    END IF;

  END IF;

  -- R1/B: persist the complete first-event result even when applied is zero.
  -- A zero-amount refund_clawback row changes no balance and does not count as
  -- spend, but its unique canonical key is the durable replay barrier.
  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    ledger_type,
    reason_code,
    counts_as_spend,
    source_type,
    source_id,
    source_refund_id,
    grant_period_key,
    description,
    idempotency_key,
    balance_before,
    balance_after,
    metadata
  ) VALUES (
    p_user_id,
    -v_applied,
    'deduction',
    'refund_clawback',
    'refund_clawback',
    FALSE,
    'stripe_refund',
    p_refund_id,
    p_refund_id,
    p_period_key,
    format(
      'Stripe subscription refund credit clawback [subscription:%s refund:%s grants:1]',
      p_subscription_id,
      COALESCE(NULLIF(btrim(COALESCE(p_refund_id, '')), ''), 'unknown')
    ),
    p_idempotency_key,
    v_balance_before,
    v_balance_before - v_applied,
    jsonb_build_object(
      'canonicalResult', 'refund_clawback',
      'eventId', p_event_id,
      'subscriptionId', p_subscription_id,
      'periodKey', p_period_key,
      'refundId', p_refund_id,
      'idempotencyKey', p_idempotency_key,
      'requiredClawbackAmount', v_clawback,
      'appliedClawbackAmount', v_applied,
      'shortfallAmount', v_shortfall,
      'reviewRequired', (v_shortfall > 0),
      'reversedGrantCount', 1
    )
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT
    v_transaction_id,
    v_balance_before - v_applied,
    v_clawback,
    v_applied,
    v_shortfall,
    FALSE,
    TRUE,
    FALSE,
    TRUE,
    FALSE,
    v_grant_granted,
    v_grant_consumed;
END;
$$;


CREATE OR REPLACE FUNCTION public.atomic_grant_annual_subscription_credits(
  p_user_id UUID,
  p_membership_plan_id UUID,
  p_stripe_subscription_id TEXT,
  p_stripe_invoice_id TEXT,
  p_grant_period_key TEXT,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ,
  p_period_index INTEGER,
  p_total_periods INTEGER,
  p_credits_granted INTEGER,
  p_idempotency_key TEXT,
  p_description TEXT,
  p_source_type TEXT,
  p_source_id TEXT,
  p_source_order_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB,
  p_grant_metadata JSONB DEFAULT '{}'::JSONB,
  p_now TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  amount INTEGER,
  is_idempotent BOOLEAN,
  granted BOOLEAN,
  blocked_by_termination BOOLEAN,
  grant_id UUID,
  credits_granted INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_subscription_termination_at TIMESTAMPTZ;
  v_term_membership_plan_id UUID;
  v_term_billing_cycle TEXT;
  v_term_start TIMESTAMPTZ;
  v_term_end TIMESTAMPTZ;
  v_expected_period_start TIMESTAMPTZ;
  v_expected_period_end TIMESTAMPTZ;
  v_expected_period_key TEXT;
  v_existing_grant_id UUID;
  v_existing_grant_transaction_id UUID;
  v_existing_grant_credits INTEGER;
  v_existing_period_start TIMESTAMPTZ;
  v_existing_period_end TIMESTAMPTZ;
  v_existing_period_index INTEGER;
  v_existing_total_periods INTEGER;
  v_existing_period_key TEXT;
  v_existing_membership_plan_id UUID;
  v_transaction_id UUID;
  v_grant_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_USER_REQUIRED';
  END IF;

  IF btrim(COALESCE(p_stripe_subscription_id, '')) = '' THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  IF btrim(COALESCE(p_grant_period_key, '')) = ''
     OR btrim(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_IDEMPOTENCY_REQUIRED';
  END IF;

  IF p_credits_granted IS NULL OR p_credits_granted <= 0 THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_AMOUNT_MUST_BE_POSITIVE';
  END IF;

  -- Lock order begins at the profile, matching the refund and existing billing
  -- RPCs. No credit mutation occurs before the termination re-read below.
  SELECT credits
  INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_PROFILE_MISSING: %', p_user_id;
  END IF;

  -- Lock the exact subscription mirror after the profile lock. This is the
  -- fresh database state, not the cron's earlier application snapshot.
  SELECT membership_plan_id, billing_cycle, current_period_start, current_period_end,
         credit_release_terminated_at
  INTO v_term_membership_plan_id, v_term_billing_cycle, v_term_start, v_term_end,
       v_subscription_termination_at
  FROM user_subscriptions
  WHERE stripe_subscription_id = p_stripe_subscription_id
    AND user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_SUBSCRIPTION_MIRROR_MISSING: %', p_stripe_subscription_id;
  END IF;

  IF v_subscription_termination_at IS NOT NULL THEN
    RETURN QUERY SELECT
      NULL::UUID,
      v_balance_before,
      v_balance_before,
      0,
      FALSE,
      FALSE,
      TRUE,
      NULL::UUID,
      0;
    RETURN;
  END IF;

  -- The cron input is only a hint. Under the profile -> subscription lock,
  -- derive the one canonical annual period from the mirror and reject any
  -- stale-term, malformed, or replay-poisoning request before ledger writes.
  IF v_term_billing_cycle IS DISTINCT FROM 'yearly'
     OR v_term_membership_plan_id IS DISTINCT FROM p_membership_plan_id
     OR v_term_start IS NULL OR v_term_end IS NULL OR v_term_end <= v_term_start
     OR p_period_index IS NULL OR p_period_index NOT BETWEEN 1 AND 12
     OR p_total_periods IS NULL OR p_total_periods <> 12 THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_CURRENT_TERM_IDENTITY_INVALID';
  END IF;

  v_expected_period_start := (
    (v_term_start AT TIME ZONE 'UTC') + make_interval(months => p_period_index - 1)
  ) AT TIME ZONE 'UTC';
  v_expected_period_end := LEAST(
    CASE WHEN p_period_index = 12 THEN v_term_end
      ELSE (((v_term_start AT TIME ZONE 'UTC') + make_interval(months => p_period_index)) AT TIME ZONE 'UTC')
    END,
    v_term_end
  );
  v_expected_period_key := format(
    'annual:%s:%s',
    to_char(v_term_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    lpad(p_period_index::TEXT, 2, '0')
  );

  IF v_expected_period_start >= v_expected_period_end
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start IS DISTINCT FROM v_expected_period_start
     OR p_period_end IS DISTINCT FROM v_expected_period_end
     OR p_grant_period_key IS DISTINCT FROM v_expected_period_key THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_STALE_OR_NONCANONICAL_PERIOD_INPUT';
  END IF;

  -- Recheck both idempotency identities while the profile and subscription
  -- locks are held. The subscription-period unique index remains the final
  -- database constraint for any unexpected caller.
  SELECT g.id, g.credit_transaction_id, g.credits_granted, g.period_start, g.period_end,
         g.period_index, g.total_periods, g.grant_period_key, g.membership_plan_id
  INTO v_existing_grant_id, v_existing_grant_transaction_id, v_existing_grant_credits,
       v_existing_period_start, v_existing_period_end, v_existing_period_index,
       v_existing_total_periods, v_existing_period_key, v_existing_membership_plan_id
  FROM subscription_credit_grants AS g
  WHERE g.stripe_subscription_id = p_stripe_subscription_id
    AND (g.idempotency_key = p_idempotency_key OR g.grant_period_key = p_grant_period_key)
  ORDER BY (g.idempotency_key = p_idempotency_key) DESC, g.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_membership_plan_id IS DISTINCT FROM v_term_membership_plan_id
       OR v_existing_period_index IS DISTINCT FROM p_period_index
       OR v_existing_total_periods IS DISTINCT FROM 12
       OR v_existing_period_start IS DISTINCT FROM v_expected_period_start
       OR v_existing_period_end IS DISTINCT FROM v_expected_period_end
       OR v_existing_period_key IS DISTINCT FROM v_expected_period_key THEN
      RAISE EXCEPTION 'ANNUAL_GRANT_EXISTING_REPLAY_ROW_NONCANONICAL';
    END IF;
    RETURN QUERY SELECT
      v_existing_grant_transaction_id,
      v_balance_before,
      v_balance_before,
      COALESCE(v_existing_grant_credits, 0),
      TRUE,
      FALSE,
      FALSE,
      v_existing_grant_id,
      COALESCE(v_existing_grant_credits, 0);
    RETURN;
  END IF;

  v_balance_after := v_balance_before + p_credits_granted;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description,
    idempotency_key,
    balance_before,
    balance_after,
    ledger_type,
    reason_code,
    counts_as_spend,
    source_type,
    source_id,
    source_order_id,
    grant_period_key,
    metadata
  ) VALUES (
    p_user_id,
    p_credits_granted,
    'addition',
    p_description,
    p_idempotency_key,
    v_balance_before,
    v_balance_after,
    'grant',
    'annual_monthly_release',
    FALSE,
    p_source_type,
    p_source_id,
    p_source_order_id,
    p_grant_period_key,
    COALESCE(p_metadata, '{}'::JSONB)
  )
  RETURNING id INTO v_transaction_id;

  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_PROFILE_UPDATE_MISS: %', p_user_id;
  END IF;

  INSERT INTO subscription_credit_grants (
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
    metadata,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_membership_plan_id,
    p_stripe_subscription_id,
    p_stripe_invoice_id,
    'yearly',
    'annual_monthly_release',
    p_grant_period_key,
    p_period_start,
    p_period_end,
    p_period_index,
    p_total_periods,
    p_credits_granted,
    'granted',
    p_idempotency_key,
    v_transaction_id,
    COALESCE(p_grant_metadata, '{}'::JSONB),
    v_now,
    v_now
  )
  RETURNING id INTO v_grant_id;

  RETURN QUERY SELECT
    v_transaction_id,
    v_balance_before,
    v_balance_after,
    p_credits_granted,
    FALSE,
    TRUE,
    FALSE,
    v_grant_id,
    p_credits_granted;
END;
$$;


CREATE OR REPLACE FUNCTION public.atomic_grant_subscription_invoice_credits(
  p_user_id UUID,
  p_membership_plan_id UUID,
  p_stripe_subscription_id TEXT,
  p_stripe_invoice_id TEXT,
  p_source_order_id UUID,
  p_amount_total INTEGER DEFAULT NULL,
  p_currency TEXT DEFAULT 'usd',
  p_payment_status TEXT DEFAULT 'paid',
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_grant_period_key TEXT DEFAULT NULL,
  p_period_start TIMESTAMPTZ DEFAULT NULL,
  p_period_end TIMESTAMPTZ DEFAULT NULL,
  p_period_index INTEGER DEFAULT NULL,
  p_total_periods INTEGER DEFAULT 1,
  p_credits_granted INTEGER DEFAULT NULL,
  p_billing_cycle TEXT DEFAULT 'monthly',
  p_membership_level TEXT DEFAULT NULL,
  p_can_promote_checkout_order BOOLEAN DEFAULT FALSE,
  p_grant_type TEXT DEFAULT 'monthly_invoice',
  p_idempotency_key TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_source_type TEXT DEFAULT 'stripe_invoice',
  p_source_id TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB,
  p_grant_metadata JSONB DEFAULT '{}'::JSONB,
  p_now TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  amount INTEGER,
  is_idempotent BOOLEAN,
  granted BOOLEAN,
  blocked_by_termination BOOLEAN,
  grant_id UUID,
  credits_granted INTEGER,
  invoice_order_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_source_status TEXT;
  v_source_payment_status TEXT;
  v_source_metadata JSONB;
  v_source_customer_id TEXT;
  v_source_price_id TEXT;
  v_source_checkout_session_id TEXT;
  v_invoice_status TEXT;
  v_invoice_payment_status TEXT;
  v_invoice_metadata JSONB;
  v_mirror_id UUID;
  v_mirror_metadata JSONB;
  v_terminated_at TIMESTAMPTZ;
  v_grant_period_start TIMESTAMPTZ;
  v_grant_period_end TIMESTAMPTZ;
  v_grant_period_key TEXT;
  v_grant_period_index INTEGER;
  v_grant_total_periods INTEGER;
  v_existing_grant_id UUID;
  v_existing_grant_transaction_id UUID;
  v_existing_grant_credits INTEGER;
  v_existing_grant_period_start TIMESTAMPTZ;
  v_existing_grant_period_end TIMESTAMPTZ;
  v_existing_grant_period_key TEXT;
  v_existing_grant_period_index INTEGER;
  v_existing_grant_total_periods INTEGER;
  v_transaction_id UUID;
  v_grant_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_membership_plan_id IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_subscription_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_invoice_id, '')), '') IS NULL
     OR p_source_order_id IS NULL
     OR NULLIF(btrim(COALESCE(p_grant_period_key, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL
     OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start
     OR p_credits_granted IS NULL OR p_credits_granted <= 0 THEN
    RAISE EXCEPTION 'INVOICE_GRANT_ADMISSION_INPUT_INVALID';
  END IF;

  SELECT credits INTO v_balance_before
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_GRANT_PROFILE_MISSING: %', p_user_id;
  END IF;

  SELECT status, payment_status, metadata, stripe_customer_id, stripe_price_id, stripe_checkout_session_id
  INTO v_source_status, v_source_payment_status, v_source_metadata, v_source_customer_id, v_source_price_id, v_source_checkout_session_id
  FROM payment_orders WHERE id = p_source_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_GRANT_SOURCE_ORDER_MISSING: %', p_source_order_id;
  END IF;

  SELECT id, status, payment_status, metadata
  INTO invoice_order_id, v_invoice_status, v_invoice_payment_status, v_invoice_metadata
  FROM payment_orders
  WHERE stripe_invoice_id = p_stripe_invoice_id
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;

  IF lower(COALESCE(v_source_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_source_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_source_metadata ? 'stripeRefund'
     OR v_source_metadata ? 'subscriptionCreditGrantReversal'
     OR lower(COALESCE(v_invoice_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_invoice_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_invoice_metadata ? 'stripeRefund'
     OR v_invoice_metadata ? 'subscriptionCreditGrantReversal' THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  SELECT id, credit_release_terminated_at, metadata
  INTO v_mirror_id, v_terminated_at, v_mirror_metadata
  FROM user_subscriptions
  WHERE user_id = p_user_id AND stripe_subscription_id = p_stripe_subscription_id
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;

  IF v_mirror_id IS NOT NULL AND v_terminated_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  -- Invoice p_period_start/end are the full Stripe subscription term. The
  -- annual grant row receives its own internally derived period-01 window.
  IF p_billing_cycle = 'yearly' THEN
    IF p_grant_type IS DISTINCT FROM 'annual_monthly_release'
       OR p_period_index IS DISTINCT FROM 1
       OR p_total_periods IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := LEAST(
      (((p_period_start AT TIME ZONE 'UTC') + make_interval(months => 1)) AT TIME ZONE 'UTC'),
      p_period_end
    );
    v_grant_period_index := 1;
    v_grant_total_periods := 12;
    v_grant_period_key := format(
      'annual:%s:01',
      to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    IF v_grant_period_start >= v_grant_period_end
       OR p_grant_period_key IS DISTINCT FROM v_grant_period_key THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_TERM_OR_KEY_NONCANONICAL';
    END IF;
  ELSIF p_billing_cycle = 'monthly' THEN
    IF p_grant_type IS DISTINCT FROM 'monthly_invoice' THEN
      RAISE EXCEPTION 'INVOICE_GRANT_MONTHLY_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := p_period_end;
    v_grant_period_index := p_period_index;
    v_grant_total_periods := p_total_periods;
    v_grant_period_key := p_grant_period_key;
  ELSE
    RAISE EXCEPTION 'INVOICE_GRANT_BILLING_CYCLE_INVALID';
  END IF;

  SELECT id, credit_transaction_id, credits_granted, period_start, period_end,
         grant_period_key, period_index, total_periods
  INTO v_existing_grant_id, v_existing_grant_transaction_id, v_existing_grant_credits,
       v_existing_grant_period_start, v_existing_grant_period_end,
       v_existing_grant_period_key, v_existing_grant_period_index, v_existing_grant_total_periods
  FROM subscription_credit_grants
  WHERE stripe_subscription_id = p_stripe_subscription_id
    AND (idempotency_key = p_idempotency_key OR grant_period_key = p_grant_period_key)
  ORDER BY (idempotency_key = p_idempotency_key) DESC, created_at ASC
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_existing_grant_period_start IS DISTINCT FROM v_grant_period_start
       OR v_existing_grant_period_end IS DISTINCT FROM v_grant_period_end
       OR v_existing_grant_period_key IS DISTINCT FROM v_grant_period_key
       OR v_existing_grant_period_index IS DISTINCT FROM v_grant_period_index
       OR v_existing_grant_total_periods IS DISTINCT FROM v_grant_total_periods THEN
      RAISE EXCEPTION 'INVOICE_GRANT_EXISTING_REPLAY_ROW_NONCANONICAL';
    END IF;
    RETURN QUERY SELECT v_existing_grant_transaction_id, v_balance_before, v_balance_before,
      COALESCE(v_existing_grant_credits, 0), TRUE, FALSE, FALSE, v_existing_grant_id,
      COALESCE(v_existing_grant_credits, 0), invoice_order_id;
    RETURN;
  END IF;

  v_balance_after := v_balance_before + p_credits_granted;
  INSERT INTO credit_transactions (
    user_id, amount, type, description, idempotency_key, balance_before, balance_after,
    ledger_type, reason_code, counts_as_spend, source_type, source_id, source_order_id,
    grant_period_key, metadata
  ) VALUES (
    p_user_id, p_credits_granted, 'addition', p_description, p_idempotency_key, v_balance_before, v_balance_after,
    'grant', p_grant_type, FALSE, p_source_type, p_source_id, p_source_order_id,
    v_grant_period_key, COALESCE(p_metadata, '{}'::JSONB)
  ) RETURNING id INTO v_transaction_id;

  UPDATE profiles
  SET credits = v_balance_after,
      membership_level = COALESCE(NULLIF(btrim(p_membership_level), ''), membership_level)
  WHERE id = p_user_id;

  INSERT INTO subscription_credit_grants (
    user_id, membership_plan_id, stripe_subscription_id, stripe_invoice_id, billing_cycle,
    grant_type, grant_period_key, period_start, period_end, period_index, total_periods,
    credits_granted, status, idempotency_key, credit_transaction_id, metadata, created_at, updated_at
  ) VALUES (
    p_user_id, p_membership_plan_id, p_stripe_subscription_id, p_stripe_invoice_id,
    CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
    p_grant_type, v_grant_period_key, v_grant_period_start, v_grant_period_end, v_grant_period_index, v_grant_total_periods,
    p_credits_granted, 'granted', p_idempotency_key, v_transaction_id, COALESCE(p_grant_metadata, '{}'::JSONB), v_now, v_now
  ) RETURNING id INTO v_grant_id;

  IF v_mirror_id IS NULL THEN
    INSERT INTO user_subscriptions (
      user_id, membership_plan_id, stripe_customer_id, stripe_subscription_id,
      stripe_price_id, billing_cycle, status, cancel_at_period_end,
      current_period_start, current_period_end, metadata, updated_at
    ) VALUES (
      p_user_id, p_membership_plan_id, COALESCE(v_source_customer_id, p_stripe_customer_id), p_stripe_subscription_id,
      v_source_price_id, CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END, 'active', 'false',
      p_period_start, p_period_end,
      jsonb_build_object(
        'lastInvoiceId', p_stripe_invoice_id,
        'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
        'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ),
      v_now
    );
  ELSE
    UPDATE user_subscriptions
    SET membership_plan_id = p_membership_plan_id,
        stripe_customer_id = COALESCE(v_source_customer_id, p_stripe_customer_id),
        stripe_price_id = v_source_price_id,
        billing_cycle = CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
        current_period_start = p_period_start,
        current_period_end = p_period_end,
        metadata = COALESCE(v_mirror_metadata, '{}'::JSONB) || jsonb_build_object(
          'lastInvoiceId', p_stripe_invoice_id,
          'lastInvoicePaymentStatus', COALESCE(p_payment_status, 'paid'),
          'transactionId', v_transaction_id,
          'subscriptionCreditGrantId', v_grant_id,
          'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
        ),
        updated_at = v_now
    WHERE id = v_mirror_id
      AND credit_release_terminated_at IS NULL;
  END IF;

  IF invoice_order_id IS NOT NULL THEN
    UPDATE payment_orders SET
      status = 'completed', payment_status = COALESCE(p_payment_status, 'paid'), fulfilled_at = v_now,
      metadata = COALESCE(v_invoice_metadata, '{}'::JSONB) || jsonb_build_object(
        'source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ), updated_at = v_now
    WHERE id = invoice_order_id
      AND lower(COALESCE(status, '')) NOT IN ('refunded', 'partially_refunded')
      AND lower(COALESCE(payment_status, '')) NOT IN ('refunded', 'partially_refunded');
  ELSIF p_can_promote_checkout_order AND v_source_checkout_session_id IS NOT NULL THEN
    UPDATE payment_orders SET
      stripe_invoice_id = p_stripe_invoice_id, stripe_subscription_id = p_stripe_subscription_id,
      status = 'completed', payment_status = COALESCE(p_payment_status, 'paid'), fulfilled_at = v_now,
      metadata = COALESCE(v_source_metadata, '{}'::JSONB) || jsonb_build_object(
        'source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'
      ), updated_at = v_now
    WHERE id = p_source_order_id
      AND lower(COALESCE(status, '')) NOT IN ('refunded', 'partially_refunded')
      AND lower(COALESCE(payment_status, '')) NOT IN ('refunded', 'partially_refunded')
    RETURNING id INTO invoice_order_id;
  ELSE
    INSERT INTO payment_orders (
      user_id, item_type, item_id, billing_cycle, stripe_invoice_id, stripe_subscription_id,
      stripe_customer_id, stripe_price_id, amount_total, currency, mode, status, payment_status,
      fulfilled_at, metadata, updated_at
    ) VALUES (
      p_user_id, 'membership_plan', p_membership_plan_id,
      CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
      p_stripe_invoice_id, p_stripe_subscription_id, COALESCE(v_source_customer_id, p_stripe_customer_id),
      v_source_price_id, p_amount_total, COALESCE(p_currency, 'usd'), 'subscription', 'completed',
      COALESCE(p_payment_status, 'paid'), v_now,
      jsonb_build_object('source', 'invoice.payment_succeeded', 'transactionId', v_transaction_id,
        'subscriptionCreditGrantId', v_grant_id, 'grantedCredits', p_credits_granted,
        'fulfillmentSource', 'atomic_grant_subscription_invoice_credits'), v_now
    ) RETURNING id INTO invoice_order_id;
  END IF;

  RETURN QUERY SELECT v_transaction_id, v_balance_before, v_balance_after, p_credits_granted,
    FALSE, TRUE, FALSE, v_grant_id, p_credits_granted, invoice_order_id;
END;
$$;


-- Reassert the SEC-1 service-role-only posture for the three repaired RPCs.
ALTER FUNCTION public.atomic_refund_termination_clawback(uuid,text,text,text,text,text,boolean,text,timestamptz) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_refund_termination_clawback(uuid,text,text,text,text,text,boolean,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_refund_termination_clawback(uuid,text,text,text,text,text,boolean,text,timestamptz) TO service_role;

ALTER FUNCTION public.atomic_grant_annual_subscription_credits(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,text,text,uuid,jsonb,jsonb,timestamptz) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_grant_annual_subscription_credits(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,text,text,uuid,jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_grant_annual_subscription_credits(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,text,text,uuid,jsonb,jsonb,timestamptz) TO service_role;

ALTER FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz) TO service_role;

