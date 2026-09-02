/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- REFUND-1B forward repair for expired unresolved quarantine.
-- Migration 0060 is applied/history and remains immutable. Current-grant
-- allocation keeps its period window, while unresolved quarantine is global
-- for every grant whose represented balance may still be in profiles.credits.

BEGIN;

CREATE OR REPLACE FUNCTION public.atomic_pre_deduct(
  p_user_id UUID,
  p_amount INTEGER,
  p_reason TEXT DEFAULT 'AI 对话预扣',
  p_request_id UUID DEFAULT NULL
)
RETURNS TABLE (
  pre_deduct_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pre_deduct_id UUID;
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_existing_id UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_covering_count INTEGER := 0;
  v_review_required_count INTEGER := 0;
  v_missing_mirror_count INTEGER := 0;
  v_malformed_covering_count INTEGER := 0;
  v_unexpected_status_count INTEGER := 0;
  v_canonical_candidate_count INTEGER := 0;
  v_quarantined_terminated_amount INTEGER := 0;
  v_to_period INTEGER := 0;
  v_to_other INTEGER;
BEGIN
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM billing_history
    WHERE user_id = p_user_id
      AND operation_type = 'pre_deduct'
      AND metadata->>'requestId' = p_request_id::TEXT
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT metadata->>'balance_before', metadata->>'balance_after'
      INTO v_balance_before, v_balance_after
      FROM billing_history
      WHERE id = v_existing_id;

      RETURN QUERY SELECT
        v_existing_id,
        COALESCE(v_balance_before::INTEGER, 0),
        COALESCE(v_balance_after::INTEGER, 0),
        TRUE;
      RETURN;
    END IF;
  END IF;

  SELECT credits INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION '预扣积分必须为正数: %', p_amount;
  END IF;

  IF v_balance_before < p_amount THEN
    RAISE EXCEPTION '积分不足: 需要 %, 当前 %', p_amount, v_balance_before;
  END IF;

  -- Current-grant census: period predicates are intentional here because
  -- these counters locate and validate the grant allocated by this request.
  SELECT
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND (us.id IS NULL OR us.credit_release_terminated_at IS NULL)
    ),
    count(*) FILTER (WHERE g.status = 'granted' AND us.id IS NULL),
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND g.accounting_state = 'trusted'
        AND us.id IS NOT NULL
        AND us.credit_release_terminated_at IS NULL
        AND NOT COALESCE(public.refund_1b_is_canonical_period_identity(
          us.user_id, us.stripe_subscription_id, us.membership_plan_id,
          us.billing_cycle, us.current_period_start, us.current_period_end,
          g.user_id, g.stripe_subscription_id, g.membership_plan_id,
          g.billing_cycle, g.grant_type, g.grant_period_key, g.period_start,
          g.period_end, g.period_index, g.total_periods, g.stripe_invoice_id
        ), FALSE)
    ),
    count(*) FILTER (WHERE g.status IS NULL OR g.status NOT IN ('granted', 'reversed')),
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND g.accounting_state = 'trusted'
        AND us.id IS NOT NULL
        AND us.credit_release_terminated_at IS NULL
        AND COALESCE(public.refund_1b_is_canonical_period_identity(
          us.user_id, us.stripe_subscription_id, us.membership_plan_id,
          us.billing_cycle, us.current_period_start, us.current_period_end,
          g.user_id, g.stripe_subscription_id, g.membership_plan_id,
          g.billing_cycle, g.grant_type, g.grant_period_key, g.period_start,
          g.period_end, g.period_index, g.total_periods, g.stripe_invoice_id
        ), FALSE)
    )
  INTO v_covering_count, v_missing_mirror_count, v_malformed_covering_count,
       v_unexpected_status_count, v_canonical_candidate_count
  FROM subscription_credit_grants AS g
  LEFT JOIN user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id
    AND g.period_start <= now()
    AND g.period_end > now();

  -- Global unresolved quarantine: do not attach period_end to either safety
  -- barrier. A review row remains fail-closed until explicitly transitioned;
  -- a terminated trusted remainder stays unavailable while in profiles.credits.
  SELECT
    count(*) FILTER (WHERE g.accounting_state <> 'trusted'),
    COALESCE(sum(
      CASE
        WHEN g.status = 'granted'
         AND g.accounting_state = 'trusted'
         AND EXISTS (
           SELECT 1
           FROM user_subscriptions AS terminated_us
           WHERE terminated_us.stripe_subscription_id = g.stripe_subscription_id
             AND terminated_us.user_id = p_user_id
             AND terminated_us.credit_release_terminated_at IS NOT NULL
         )
        THEN GREATEST(g.credits_granted - g.consumed_amount, 0)
        ELSE 0
      END
    ), 0)::INTEGER
  INTO v_review_required_count, v_quarantined_terminated_amount
  FROM subscription_credit_grants AS g
  WHERE g.user_id = p_user_id;

  IF v_review_required_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';
  END IF;

  IF v_covering_count > 1 OR v_canonical_candidate_count > 1 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %',
      GREATEST(v_covering_count, v_canonical_candidate_count);
  END IF;

  IF v_missing_mirror_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_SUBSCRIPTION_MIRROR_MISSING';
  END IF;

  IF v_malformed_covering_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW';
  END IF;

  IF v_unexpected_status_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_UNEXPECTED_GRANT_STATUS';
  END IF;

  IF v_covering_count > 0 AND v_canonical_candidate_count = 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW';
  END IF;

  SELECT g.id, g.grant_period_key, g.credits_granted, g.consumed_amount
  INTO v_charged_grant_id, v_period_key, v_grant_granted, v_grant_consumed
  FROM subscription_credit_grants AS g
  JOIN user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id
    AND g.status = 'granted'
    AND g.accounting_state = 'trusted'
    AND g.period_start <= now()
    AND g.period_end > now()
    AND us.credit_release_terminated_at IS NULL
    AND COALESCE(public.refund_1b_is_canonical_period_identity(
      us.user_id, us.stripe_subscription_id, us.membership_plan_id,
      us.billing_cycle, us.current_period_start, us.current_period_end,
      g.user_id, g.stripe_subscription_id, g.membership_plan_id,
      g.billing_cycle, g.grant_type, g.grant_period_key, g.period_start,
      g.period_end, g.period_index, g.total_periods, g.stripe_invoice_id
    ), FALSE)
  FOR UPDATE OF g;

  v_to_other := p_amount;
  IF v_charged_grant_id IS NOT NULL THEN
    v_to_period := LEAST(p_amount, GREATEST(v_grant_granted - v_grant_consumed, 0));
    v_to_other := p_amount - v_to_period;
  END IF;

  IF v_to_other > GREATEST(v_balance_before - v_to_period - v_quarantined_terminated_amount, 0) THEN
    RAISE EXCEPTION 'PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED';
  END IF;

  v_balance_after := v_balance_before - p_amount;
  UPDATE profiles SET credits = v_balance_after WHERE id = p_user_id;

  IF v_charged_grant_id IS NOT NULL AND v_to_period > 0 THEN
    UPDATE subscription_credit_grants
    SET consumed_amount = consumed_amount + v_to_period,
        updated_at = now()
    WHERE id = v_charged_grant_id
      AND accounting_state = 'trusted';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';
    END IF;
  END IF;

  INSERT INTO billing_history (user_id, operation_type, amount, reason, metadata)
  VALUES (
    p_user_id,
    'pre_deduct',
    -p_amount,
    p_reason,
    jsonb_build_object(
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'timestamp', now()::TEXT,
      'requestId', p_request_id,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other
    )
  )
  RETURNING id INTO v_pre_deduct_id;

  RETURN QUERY SELECT v_pre_deduct_id, v_balance_before, v_balance_after, FALSE;
END;
$$;

-- Re-establish the SEC-1 service-role-only posture for the replaced function.
DO $$
DECLARE
  v_signature CONSTANT TEXT := 'public.atomic_pre_deduct(uuid,integer,text,uuid)';
BEGIN
  IF to_regprocedure(v_signature) IS NULL THEN
    RAISE EXCEPTION 'REFUND-1B 0061 expected function missing: %', v_signature;
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
END
$$;

COMMIT;
