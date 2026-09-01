/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- REFUND-1B post-merge forward repair.
-- Applied migrations 0053-0059 are immutable. This migration quarantines
-- unproven legacy grant accounting, normalizes only uniquely provable annual
-- period-01 identities, reconstructs consumed_amount only from a complete
-- bound ledger chain, and closes the terminated/reversed pre-deduct blocker.

BEGIN;

ALTER TABLE public.subscription_credit_grants
  ADD COLUMN accounting_state TEXT NOT NULL DEFAULT 'review_required',
  ADD COLUMN accounting_review_reason TEXT
    DEFAULT 'legacy_period_identity_or_consumption_unproven';

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_accounting_state_check
    CHECK (accounting_state IN ('trusted', 'review_required')),
  ADD CONSTRAINT subscription_credit_grants_accounting_review_check
    CHECK (
      (accounting_state = 'trusted' AND accounting_review_reason IS NULL)
      OR (
        accounting_state = 'review_required'
        AND NULLIF(btrim(accounting_review_reason), '') IS NOT NULL
      )
    );

-- The only legacy annual repair allowed here is the exact period-01 shape
-- created before the calendar-window contract existed. A unique mirror, exact
-- user/plan/billing/term binding, canonical key, and unique matching grant are
-- all required. Any ambiguity remains quarantined.
WITH annual_period_01_candidates AS (
  SELECT
    g.id,
    LEAST(
      ((us.current_period_start AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC',
      us.current_period_end
    ) AS canonical_period_end
  FROM public.subscription_credit_grants AS g
  JOIN public.user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = g.user_id
   AND us.membership_plan_id = g.membership_plan_id
   AND us.billing_cycle = g.billing_cycle
  WHERE g.billing_cycle = 'yearly'
    AND g.grant_type = 'annual_monthly_release'
    AND g.period_index = 1
    AND g.total_periods = 12
    AND g.period_start = us.current_period_start
    AND g.period_end = us.current_period_end
    AND us.current_period_start IS NOT NULL
    AND us.current_period_end IS NOT NULL
    AND us.current_period_end > us.current_period_start
    AND g.grant_period_key = format(
      'annual:%s:01',
      to_char(us.current_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    AND (
      SELECT count(*)
      FROM public.user_subscriptions AS mirror
      WHERE mirror.stripe_subscription_id = g.stripe_subscription_id
        AND mirror.user_id = g.user_id
        AND mirror.membership_plan_id = g.membership_plan_id
        AND mirror.billing_cycle = g.billing_cycle
        AND mirror.current_period_start = us.current_period_start
        AND mirror.current_period_end = us.current_period_end
    ) = 1
    AND (
      SELECT count(*)
      FROM public.subscription_credit_grants AS sibling
      WHERE sibling.stripe_subscription_id = g.stripe_subscription_id
        AND sibling.grant_period_key = g.grant_period_key
    ) = 1
)
UPDATE public.subscription_credit_grants AS g
SET period_end = candidate.canonical_period_end,
    metadata = COALESCE(g.metadata, '{}'::JSONB) || jsonb_build_object(
      'refund1bLegacyPeriodNormalization', jsonb_build_object(
        'migration', '0060_refund_1b_post_merge_forward_repair',
        'previousPeriodEnd', g.period_end,
        'normalizedPeriodEnd', candidate.canonical_period_end,
        'basis', 'unique_annual_period_01_full_term_identity'
      )
    ),
    updated_at = now()
FROM annual_period_01_candidates AS candidate
WHERE g.id = candidate.id
  AND candidate.canonical_period_end > g.period_start
  AND candidate.canonical_period_end < g.period_end;

-- Identify grants whose current identity is provably canonical against exactly
-- one subscription mirror. This changes only the review reason; trust still
-- requires the independent ledger proof below.
WITH identity_proof AS (
  SELECT g.id
  FROM public.subscription_credit_grants AS g
  JOIN public.user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = g.user_id
  GROUP BY g.id
  HAVING count(*) = 1
     AND bool_and(COALESCE(public.refund_1b_is_canonical_period_identity(
       us.user_id,
       us.stripe_subscription_id,
       us.membership_plan_id,
       us.billing_cycle,
       us.current_period_start,
       us.current_period_end,
       g.user_id,
       g.stripe_subscription_id,
       g.membership_plan_id,
       g.billing_cycle,
       g.grant_type,
       g.grant_period_key,
       g.period_start,
       g.period_end,
       g.period_index,
       g.total_periods,
       g.stripe_invoice_id
     ), FALSE))
)
UPDATE public.subscription_credit_grants AS g
SET accounting_review_reason = 'legacy_consumption_unproven'
FROM identity_proof AS proof
WHERE g.id = proof.id;

-- A legacy consumed amount is trusted only if at least one bound pre-deduct
-- exists and every record in the chain is internally complete. A terminal
-- record, when present, must be unique and carry the explicit signed
-- periodConsumedDelta. Absence of ledger evidence never proves zero.
WITH bound_pre_deduct AS (
  SELECT
    g.id AS grant_id,
    pre.id AS pre_deduct_id,
    CASE
      WHEN jsonb_typeof(pre.metadata->'amountToPeriod') = 'number'
       AND jsonb_typeof(pre.metadata->'amountToOther') = 'number'
       AND (pre.metadata->>'amountToPeriod') ~ '^[0-9]+$'
       AND (pre.metadata->>'amountToOther') ~ '^[0-9]+$'
       AND pre.user_id = g.user_id
       AND pre.metadata->>'chargedGrantId' = g.id::TEXT
       AND pre.metadata->>'chargedPeriodKey' = g.grant_period_key
       AND (pre.metadata->>'amountToPeriod')::NUMERIC
           + (pre.metadata->>'amountToOther')::NUMERIC = ABS(pre.amount)::NUMERIC
      THEN (pre.metadata->>'amountToPeriod')::NUMERIC
      ELSE NULL
    END AS initial_period_consumed
  FROM public.subscription_credit_grants AS g
  JOIN public.billing_history AS pre
    ON pre.operation_type = 'pre_deduct'
   AND pre.metadata->>'chargedGrantId' = g.id::TEXT
), terminal_chain AS (
  SELECT
    pre.grant_id,
    pre.pre_deduct_id,
    pre.initial_period_consumed,
    count(terminal.id) AS terminal_count,
    CASE
      WHEN count(terminal.id) = 0 THEN 0
      WHEN count(terminal.id) = 1
       AND bool_and(jsonb_typeof(terminal.metadata->'periodConsumedDelta') = 'number')
       AND bool_and((terminal.metadata->>'periodConsumedDelta') ~ '^-?[0-9]+$')
       AND bool_and(terminal.user_id = grant_row.user_id)
       AND bool_and(terminal.metadata->>'chargedGrantId' = pre.grant_id::TEXT)
       AND bool_and(terminal.metadata->>'chargedPeriodKey' = grant_row.grant_period_key)
      THEN max(
        CASE
          WHEN (terminal.metadata->>'periodConsumedDelta') ~ '^-?[0-9]+$'
          THEN (terminal.metadata->>'periodConsumedDelta')::NUMERIC
          ELSE NULL
        END
      )
      ELSE NULL
    END AS terminal_period_delta
  FROM bound_pre_deduct AS pre
  JOIN public.subscription_credit_grants AS grant_row ON grant_row.id = pre.grant_id
  LEFT JOIN public.billing_history AS terminal
    ON terminal.metadata->>'preDeductId' = pre.pre_deduct_id::TEXT
   AND terminal.operation_type IN ('settle', 'refund', 'abort_settle')
  GROUP BY pre.grant_id, pre.pre_deduct_id, pre.initial_period_consumed, grant_row.grant_period_key
), ledger_proof AS (
  SELECT
    chain.grant_id,
    sum(chain.initial_period_consumed + chain.terminal_period_delta) AS exact_consumed
  FROM terminal_chain AS chain
  GROUP BY chain.grant_id
  HAVING count(*) > 0
     AND bool_and(chain.initial_period_consumed IS NOT NULL)
     AND bool_and(chain.terminal_count <= 1)
     AND bool_and(chain.terminal_period_delta IS NOT NULL)
), identity_proof AS (
  SELECT g.id
  FROM public.subscription_credit_grants AS g
  JOIN public.user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = g.user_id
  GROUP BY g.id
  HAVING count(*) = 1
     AND bool_and(COALESCE(public.refund_1b_is_canonical_period_identity(
       us.user_id,
       us.stripe_subscription_id,
       us.membership_plan_id,
       us.billing_cycle,
       us.current_period_start,
       us.current_period_end,
       g.user_id,
       g.stripe_subscription_id,
       g.membership_plan_id,
       g.billing_cycle,
       g.grant_type,
       g.grant_period_key,
       g.period_start,
       g.period_end,
       g.period_index,
       g.total_periods,
       g.stripe_invoice_id
     ), FALSE))
)
UPDATE public.subscription_credit_grants AS g
SET consumed_amount = ledger.exact_consumed::INTEGER,
    accounting_state = 'trusted',
    accounting_review_reason = NULL,
    metadata = COALESCE(g.metadata, '{}'::JSONB) || jsonb_build_object(
      'refund1bLegacyAccountingProof', jsonb_build_object(
        'migration', '0060_refund_1b_post_merge_forward_repair',
        'basis', 'unique_identity_and_complete_bound_ledger_chain',
        'consumedAmount', ledger.exact_consumed::INTEGER
      )
    ),
    updated_at = now()
FROM ledger_proof AS ledger
JOIN identity_proof AS identity ON identity.id = ledger.grant_id
WHERE g.id = ledger.grant_id
  AND ledger.exact_consumed BETWEEN 0 AND g.credits_granted;

ALTER TABLE public.subscription_credit_grants
  ALTER COLUMN accounting_state SET DEFAULT 'trusted',
  ALTER COLUMN accounting_review_reason DROP DEFAULT;

GRANT SELECT (
  accounting_state,
  accounting_review_reason
) ON TABLE public.subscription_credit_grants TO service_role;

-- Review rows are a durable quarantine, not a display-only flag. Protected
-- accounting/identity/status fields cannot change while a row remains in that
-- state. A future separately gated repair must prove the values and transition
-- the row to trusted in the same statement.
CREATE OR REPLACE FUNCTION public.refund_1b_guard_accounting_review_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.accounting_state = 'review_required' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_GRANT_ACCOUNTING_REVIEW_REQUIRED: %', OLD.id;
  END IF;

  IF OLD.accounting_state = 'review_required'
     AND NEW.accounting_state = 'review_required'
     AND (
       NEW.consumed_amount IS DISTINCT FROM OLD.consumed_amount
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.membership_plan_id IS DISTINCT FROM OLD.membership_plan_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id
       OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle
       OR NEW.grant_type IS DISTINCT FROM OLD.grant_type
       OR NEW.grant_period_key IS DISTINCT FROM OLD.grant_period_key
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.period_index IS DISTINCT FROM OLD.period_index
       OR NEW.total_periods IS DISTINCT FROM OLD.total_periods
       OR NEW.credits_granted IS DISTINCT FROM OLD.credits_granted
     ) THEN
    RAISE EXCEPTION 'SUBSCRIPTION_GRANT_ACCOUNTING_REVIEW_REQUIRED: %', OLD.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_credit_grants_accounting_review_guard
BEFORE UPDATE OR DELETE ON public.subscription_credit_grants
FOR EACH ROW
EXECUTE FUNCTION public.refund_1b_guard_accounting_review_row();

-- Replace the existing public signature. Trusted terminated grants quarantine
-- their remaining balance but no longer block legitimate other credits;
-- reversed grants are inert. Any covering review row still fails closed.
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

  SELECT
    count(*) FILTER (
      WHERE g.status = 'granted'
        AND (us.id IS NULL OR us.credit_release_terminated_at IS NULL)
    ),
    count(*) FILTER (WHERE g.accounting_state <> 'trusted'),
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
    ),
    COALESCE(sum(
      CASE
        WHEN g.status = 'granted'
         AND g.accounting_state = 'trusted'
         AND us.credit_release_terminated_at IS NOT NULL
        THEN GREATEST(g.credits_granted - g.consumed_amount, 0)
        ELSE 0
      END
    ), 0)::INTEGER
  INTO v_covering_count, v_review_required_count, v_missing_mirror_count,
       v_malformed_covering_count, v_unexpected_status_count,
       v_canonical_candidate_count, v_quarantined_terminated_amount
  FROM subscription_credit_grants AS g
  LEFT JOIN user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.user_id = p_user_id
    AND g.period_start <= now()
    AND g.period_end > now();

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

-- Fresh refund resolution must reject any untrusted grant before the lower
-- clawback function can use consumed_amount or mutate the row.
CREATE OR REPLACE FUNCTION public.atomic_refund_termination_clawback_fresh(
  p_user_id UUID,
  p_subscription_id TEXT,
  p_event_id TEXT,
  p_refund_created_at TIMESTAMPTZ DEFAULT NULL,
  p_invoice_scope_review_reason TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'stripe_refund',
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
  consumed_amount INTEGER,
  resolved_period_key TEXT,
  review_required BOOLEAN,
  review_reason TEXT,
  idempotency_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_term_start TIMESTAMPTZ;
  v_term_end TIMESTAMPTZ;
  v_term_membership_plan_id UUID;
  v_term_billing_cycle TEXT;
  v_grant_user_id UUID;
  v_grant_subscription_id TEXT;
  v_grant_membership_plan_id UUID;
  v_grant_billing_cycle TEXT;
  v_grant_type TEXT;
  v_period_index INTEGER;
  v_total_periods INTEGER;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_grant_stripe_invoice_id TEXT;
  v_period_key TEXT;
  v_candidate_count INTEGER := 0;
  v_review_reason TEXT;
  v_grant_status TEXT;
  v_accounting_state TEXT;
  v_accounting_review_reason TEXT;
  v_event_id TEXT := NULLIF(btrim(p_event_id), '');
  v_idempotency_key TEXT;
  v_termination_only BOOLEAN;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_USER_REQUIRED';
  END IF;

  IF btrim(COALESCE(p_subscription_id, '')) = '' THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  PERFORM credits FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_PROFILE_MISSING: %', p_user_id;
  END IF;

  SELECT us.membership_plan_id, us.billing_cycle, us.current_period_start, us.current_period_end
  INTO v_term_membership_plan_id, v_term_billing_cycle, v_term_start, v_term_end
  FROM user_subscriptions AS us
  WHERE us.stripe_subscription_id = p_subscription_id
    AND us.user_id = p_user_id
  ORDER BY us.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING: %', p_subscription_id;
  END IF;

  IF p_refund_created_at IS NULL THEN
    v_review_reason := 'missing_trusted_refund_timestamp';
  ELSIF v_term_start IS NULL OR v_term_end IS NULL OR v_term_end <= v_term_start THEN
    v_review_reason := 'missing_or_invalid_trusted_term';
  ELSIF p_refund_created_at < v_term_start THEN
    v_review_reason := 'refund_timestamp_precedes_term_start';
  ELSE
    SELECT count(*) INTO v_candidate_count
    FROM subscription_credit_grants AS g
    WHERE g.stripe_subscription_id = p_subscription_id
      AND g.period_start <= p_refund_created_at
      AND p_refund_created_at < g.period_end;

    IF v_candidate_count = 0 THEN
      v_review_reason := 'no_period_window_covers_refund_timestamp';
    ELSIF v_candidate_count > 1 THEN
      v_review_reason := 'ambiguous_or_overlapping_period_windows';
    ELSE
      SELECT g.user_id, g.stripe_subscription_id, g.membership_plan_id,
             g.billing_cycle, g.grant_type, g.period_index, g.total_periods,
             g.period_start, g.period_end, g.grant_period_key,
             g.stripe_invoice_id, g.status, g.accounting_state,
             g.accounting_review_reason
      INTO v_grant_user_id, v_grant_subscription_id, v_grant_membership_plan_id,
           v_grant_billing_cycle, v_grant_type, v_period_index, v_total_periods,
           v_period_start, v_period_end, v_period_key, v_grant_stripe_invoice_id,
           v_grant_status, v_accounting_state, v_accounting_review_reason
      FROM subscription_credit_grants AS g
      WHERE g.stripe_subscription_id = p_subscription_id
        AND g.period_start <= p_refund_created_at
        AND p_refund_created_at < g.period_end
      FOR UPDATE;

      IF v_accounting_state <> 'trusted' THEN
        v_period_key := NULL;
        v_review_reason := COALESCE(
          NULLIF(btrim(v_accounting_review_reason), ''),
          'grant_accounting_review_required'
        );
      ELSIF NOT COALESCE(public.refund_1b_is_canonical_period_identity(
        p_user_id, p_subscription_id, v_term_membership_plan_id,
        v_term_billing_cycle, v_term_start, v_term_end, v_grant_user_id,
        v_grant_subscription_id, v_grant_membership_plan_id,
        v_grant_billing_cycle, v_grant_type, v_period_key, v_period_start,
        v_period_end, v_period_index, v_total_periods,
        v_grant_stripe_invoice_id
      ), FALSE) THEN
        v_period_key := NULL;
        v_review_reason := CASE
          WHEN v_term_billing_cycle = 'monthly' THEN 'noncanonical_monthly_period_window'
          WHEN v_term_billing_cycle = 'yearly' THEN 'noncanonical_annual_period_window'
          ELSE 'term_start_period_anchor_unknown'
        END;
      ELSIF v_grant_status NOT IN ('granted', 'reversed') THEN
        v_period_key := NULL;
        v_review_reason := 'unexpected_grant_status';
      END IF;
    END IF;
  END IF;

  IF v_review_reason IS NULL THEN
    v_review_reason := NULLIF(btrim(p_invoice_scope_review_reason), '');
  END IF;
  IF v_review_reason IS NULL AND v_event_id IS NULL THEN
    v_review_reason := 'missing_event_id';
  END IF;

  v_termination_only := v_review_reason IS NOT NULL OR v_period_key IS NULL;
  v_idempotency_key := format(
    'stripe_refund:subscription_grants:event:%s:sub:%s:period:%s',
    COALESCE(v_event_id, 'unlocated'),
    p_subscription_id,
    COALESCE(v_period_key, 'unlocated')
  );

  RETURN QUERY
  SELECT refund.transaction_id, refund.balance_after, refund.clawback_amount,
         refund.applied_clawback_amount, refund.shortfall_amount,
         refund.already_applied, refund.termination_written,
         refund.already_terminated, refund.grant_reversed,
         refund.already_reversed, refund.credits_granted,
         refund.consumed_amount, v_period_key, v_termination_only,
         v_review_reason, v_idempotency_key
  FROM public.atomic_refund_termination_clawback(
    p_user_id, p_subscription_id, p_event_id, v_period_key,
    v_idempotency_key, p_reason, v_termination_only, p_refund_id, p_now
  ) AS refund;
END;
$$;

-- Preserve the SEC-1 service-role-only posture for every new/replaced
-- SECURITY DEFINER function.
DO $$
DECLARE
  v_signature TEXT;
  v_service_role_only CONSTANT TEXT[] := ARRAY[
    'public.refund_1b_guard_accounting_review_row()',
    'public.atomic_pre_deduct(uuid,integer,text,uuid)',
    'public.atomic_refund_termination_clawback_fresh(uuid,text,text,timestamptz,text,text,text,timestamptz)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_service_role_only LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'REFUND-1B 0060 expected function missing: %', v_signature;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END
$$;

COMMIT;
