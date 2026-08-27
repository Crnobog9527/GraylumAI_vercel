/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: REFUND-1B precise refund clawback, termination, and consumed-amount accounting
-- Description:
--   1. subscription_credit_grants.consumed_amount with the invariant
--      0 <= consumed_amount <= credits_granted.
--   2. user_subscriptions credit-release termination columns so any refund
--      event stops future annual releases before the cancellation webhook.
--   3. Binding-aware billing RPC bodies (signatures unchanged):
--      atomic_pre_deduct binds each reservation to the charged grant/period and
--      records the (amountToPeriod, amountToOther) split into billing_history
--      metadata while reserving period quota immediately; atomic_settle /
--      atomic_finalize_ai_success / atomic_abort_settle /
--      atomic_finalize_ai_abort reuse that binding in reverse-allocation
--      order (other sources restore first, period share last) even across
--      period boundaries; overrun consumes the bound period's CURRENT
--      remaining quota (never capped by amountToPeriod); reversed/terminated
--      periods intercept restoration/overrun instead of charging other
--      sources (refund_intercepted_restoration / refund_intercepted_overrun).
--   4. Lock order stays profile -> grant for every touched path (SELECT ...
--      FOR UPDATE on profiles first, then subscription_credit_grants rows),
--      and reversed/consumed state is re-read under lock (no TOCTOU).
--   5. SEC-1 service-role-only EXECUTE/search_path posture is re-established
--      for every replaced function.
--   6. Remediation hardening: duplicate settle/refund/abort/finalize calls
--      are serialized by a post-lock recheck plus a UNIQUE partial index on
--      the terminal billing_history record keyed by preDeductId; bound-grant
--      rereads fail closed when the charged grant row is missing, deleted,
--      or in an unexpected status; settle/abort/finalize re-read the
--      user_subscriptions termination state under the grant lock so a
--      committed termination intercepts restoration/overrun even before the
--      grant row itself is marked reversed; every profile-debit path
--      enforces credits >= 0 inside the SQL body.
--   7. atomic_refund_termination_clawback: one unified refund transaction
--      (profiles FOR UPDATE -> subscription_credit_grants FOR UPDATE) that
--      writes credit-release termination (fail-closed when the mirror is
--      missing), reverses the located period grant, and claws back
--      granted - consumed under a canonical event_id + subscription_id +
--      period_key idempotency barrier with LEAST(clawback, balance).

-- ============================================
-- 1. consumed_amount invariant
-- ============================================

ALTER TABLE public.subscription_credit_grants
  ADD COLUMN consumed_amount INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_consumed_amount_check
  CHECK (0 <= consumed_amount AND consumed_amount <= credits_granted);

-- ============================================
-- 2. credit-release termination columns
-- ============================================

ALTER TABLE public.user_subscriptions
  ADD COLUMN credit_release_terminated_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN credit_release_terminated_reason TEXT,
  ADD COLUMN credit_release_terminated_event_id TEXT,
  ADD COLUMN credit_release_terminated_period_key TEXT;

-- ============================================
-- 2b. deterministic terminal-record barrier
-- ============================================
-- R7: exactly one terminal billing_history record (settle/refund/abort_settle)
-- may exist per pre-deduct. The pre-lock "already processed" checks below are
-- advisory fast paths only; this unique partial index plus the post-lock
-- rechecks make duplicate concurrent settle/finalize attempts fail closed
-- instead of letting both callers mutate the profile.

CREATE UNIQUE INDEX billing_history_terminal_pre_deduct_unique
  ON public.billing_history ((metadata->>'preDeductId'))
  WHERE operation_type IN ('settle', 'refund', 'abort_settle')
    AND metadata->>'preDeductId' IS NOT NULL;

-- ============================================
-- 2c. normative canonical period identity
-- ============================================
-- Every consumer must use the same subscription-term authority and grant
-- identity rules. This helper is pure: it reads no tables and only compares a
-- grant row with the locked/current subscription mirror supplied by its caller.
CREATE OR REPLACE FUNCTION public.refund_1b_is_canonical_period_identity(
  p_subscription_user_id UUID,
  p_subscription_id TEXT,
  p_subscription_membership_plan_id UUID,
  p_subscription_billing_cycle TEXT,
  p_term_start TIMESTAMPTZ,
  p_term_end TIMESTAMPTZ,
  p_grant_user_id UUID,
  p_grant_subscription_id TEXT,
  p_grant_membership_plan_id UUID,
  p_grant_billing_cycle TEXT,
  p_grant_type TEXT,
  p_grant_period_key TEXT,
  p_grant_period_start TIMESTAMPTZ,
  p_grant_period_end TIMESTAMPTZ,
  p_grant_period_index INTEGER,
  p_grant_total_periods INTEGER,
  p_grant_stripe_invoice_id TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    p_term_end > p_term_start
    AND p_subscription_user_id = p_grant_user_id
    AND p_subscription_id = p_grant_subscription_id
    AND p_subscription_membership_plan_id = p_grant_membership_plan_id
    AND p_subscription_billing_cycle = p_grant_billing_cycle
    AND p_grant_period_start >= p_term_start
    AND p_grant_period_end <= p_term_end
    AND p_grant_period_start < p_grant_period_end
    AND CASE
      WHEN p_subscription_billing_cycle = 'yearly' THEN
        p_grant_type = 'annual_monthly_release'
        AND p_grant_period_index BETWEEN 1 AND 12
        AND p_grant_total_periods = 12
        AND p_grant_period_start = (
          (p_term_start AT TIME ZONE 'UTC')
          + make_interval(months => p_grant_period_index - 1)
        ) AT TIME ZONE 'UTC'
        AND p_grant_period_end = LEAST(
          CASE WHEN p_grant_period_index = 12 THEN p_term_end
            ELSE (
              (p_term_start AT TIME ZONE 'UTC')
              + make_interval(months => p_grant_period_index)
            ) AT TIME ZONE 'UTC'
          END,
          p_term_end
        )
        AND p_grant_period_key = format(
          'annual:%s:%s',
          to_char(p_term_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          lpad(p_grant_period_index::TEXT, 2, '0')
        )
      WHEN p_subscription_billing_cycle = 'monthly' THEN
        p_grant_type = 'monthly_invoice'
        AND p_grant_period_index IS NULL
        AND p_grant_total_periods = 1
        AND NULLIF(btrim(COALESCE(p_grant_stripe_invoice_id, '')), '') IS NOT NULL
        AND p_grant_period_key = format(
          'invoice:%s',
          btrim(p_grant_stripe_invoice_id)
        )
        AND p_grant_period_start = p_term_start
        AND p_grant_period_end = p_term_end
      ELSE FALSE
    END;
$$;

-- ============================================
-- 3. atomic_pre_deduct: bind the reservation to the charged grant/period
-- ============================================

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
  v_malformed_covering_count INTEGER := 0;
  v_unexpected_status_count INTEGER := 0;
  v_canonical_candidate_count INTEGER := 0;
  v_to_period INTEGER := 0;
  v_to_other INTEGER;
BEGIN
  -- 1. 幂等性检查 (如果提供了 request_id)
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM billing_history
    WHERE user_id = p_user_id
      AND operation_type = 'pre_deduct'
      AND metadata->>'requestId' = p_request_id::TEXT
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT
        metadata->>'balance_before',
        metadata->>'balance_after'
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

  -- 2. 锁定用户行并获取当前余额 (锁序: profile -> grant)
  SELECT credits INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- 3. 余额检查
  IF v_balance_before < p_amount THEN
    RAISE EXCEPTION '积分不足: 需要 %, 当前 %', p_amount, v_balance_before;
  END IF;

  v_balance_after := v_balance_before - p_amount;

  -- 4. 原子更新余额
  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  -- 4b. REFUND-1B: 绑定当期 grant 并记录来源拆分 (当期优先, 封顶当期剩余额度)。
  --     周期定位用预扣时刻, 定位一次即固定; 被退款终止的订阅不参与绑定。
  -- Only a unique, canonical, currently-active grant window may be bound.
  -- This keeps a yearly period-01 from remaining eligible after its first
  -- calendar month and refuses to guess between multiple subscriptions.
  SELECT count(*),
         count(*) FILTER (
           WHERE g.status = 'granted'
             AND COALESCE(public.refund_1b_is_canonical_period_identity(
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
             ), FALSE)
         ),
         count(*) FILTER (
           WHERE NOT COALESCE(public.refund_1b_is_canonical_period_identity(
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
           ), FALSE)
         ),
         count(*) FILTER (
           WHERE g.status IS NULL OR g.status NOT IN ('granted', 'reversed')
         )
  INTO v_covering_count, v_canonical_candidate_count,
       v_malformed_covering_count, v_unexpected_status_count
  FROM subscription_credit_grants AS g
  JOIN user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.period_start <= now()
    AND g.period_end > now()
    AND us.credit_release_terminated_at IS NULL;

  IF v_covering_count > 1 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %', v_covering_count;
  END IF;

  IF v_malformed_covering_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW';
  END IF;

  IF v_unexpected_status_count > 0 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_UNEXPECTED_GRANT_STATUS';
  END IF;

  IF v_canonical_candidate_count > 1 THEN
    RAISE EXCEPTION 'PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: %', v_canonical_candidate_count;
  END IF;

  SELECT g.id, g.grant_period_key, g.credits_granted, g.consumed_amount
  INTO v_charged_grant_id, v_period_key, v_grant_granted, v_grant_consumed
  FROM subscription_credit_grants AS g
  JOIN user_subscriptions AS us
    ON us.stripe_subscription_id = g.stripe_subscription_id
   AND us.user_id = p_user_id
  WHERE g.status = 'granted'
    AND g.period_start <= now()
    AND g.period_end > now()
    AND us.credit_release_terminated_at IS NULL
    AND COALESCE(public.refund_1b_is_canonical_period_identity(
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
    ), FALSE)
  FOR UPDATE OF g;

  v_to_other := p_amount;
  IF v_charged_grant_id IS NOT NULL THEN
    v_to_period := LEAST(p_amount, GREATEST(v_grant_granted - v_grant_consumed, 0));
    v_to_other := p_amount - v_to_period;

    IF v_to_period > 0 THEN
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_to_period,
          updated_at = now()
      WHERE id = v_charged_grant_id;
    END IF;
  END IF;

  -- 5. 插入预扣记录 (含一次性来源拆分绑定)
  INSERT INTO billing_history (
    user_id,
    operation_type,
    amount,
    reason,
    metadata
  ) VALUES (
    p_user_id,
    'pre_deduct',
    -p_amount,
    p_reason,
    jsonb_build_object(
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'timestamp', NOW()::TEXT,
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

-- ============================================
-- 4. atomic_settle: binding-aware reverse allocation
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_settle(
  p_user_id UUID,
  p_pre_deduct_id UUID,
  p_actual_credits INTEGER,
  p_usage JSONB DEFAULT '{}'::JSONB,
  p_response JSONB DEFAULT NULL
)
RETURNS TABLE (
  actual_credits INTEGER,
  difference INTEGER,
  balance_after INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pre_deducted INTEGER;
  v_pre_meta JSONB;
  v_difference INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_settle UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_overrun INTEGER;
  v_intercepted_overrun INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  -- 1. 检查是否已结算
  SELECT id INTO v_existing_settle
  FROM billing_history
  WHERE operation_type = 'settle'
    AND metadata->>'preDeductId' = p_pre_deduct_id::TEXT
  LIMIT 1;

  IF v_existing_settle IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已结算: %', p_pre_deduct_id;
  END IF;

  -- 2. 获取预扣记录 (含 REFUND-1B 绑定) 并验证
  SELECT ABS(amount), metadata INTO v_pre_deducted, v_pre_meta
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  v_difference := v_pre_deducted - p_actual_credits;

  -- 3. 锁定用户行 (锁序: profile -> grant)
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- 3a. R7: 持锁后复查重复结算 (并发双调用在此串行化后失败关闭;
  --      billing_history_terminal_pre_deduct_unique 是最终硬屏障)
  SELECT id INTO v_existing_settle
  FROM billing_history
  WHERE operation_type = 'settle'
    AND metadata->>'preDeductId' = p_pre_deduct_id::TEXT
  LIMIT 1;

  IF v_existing_settle IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已结算: %', p_pre_deduct_id;
  END IF;

  v_balance_delta := v_difference;

  -- 3b. REFUND-1B: 复用预扣绑定 (跨周期也在原绑定上操作), 状态在持锁下重读。
  v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
  IF v_charged_grant_id IS NOT NULL THEN
    v_period_key := v_pre_meta->>'chargedPeriodKey';
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
    SELECT g.status, g.credits_granted, g.consumed_amount,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_granted, v_grant_consumed, v_grant_terminated
    FROM subscription_credit_grants AS g
    JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
     AND us.user_id = p_user_id
    WHERE g.id = v_charged_grant_id
      AND g.user_id = p_user_id
      AND g.grant_period_key = v_period_key
    FOR UPDATE OF g;

    IF NOT FOUND THEN
      RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
    END IF;

    IF v_grant_status NOT IN ('granted', 'reversed') THEN
      RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
    END IF;

    -- R3: 已 reversed 或订阅 termination 已落库 (即使 grant 尚未反转) 都拦截
    v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

    IF v_intercepted THEN
      -- 已退款的周期: 周期份额不返还/不追扣, 不从其他来源补扣
      IF v_difference >= 0 THEN
        v_balance_delta := LEAST(v_difference, GREATEST(v_to_other, 0));
        v_intercepted_restoration := LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSE
        v_balance_delta := 0;
        v_intercepted_overrun := p_actual_credits - v_pre_deducted;
      END IF;
    ELSE
      IF v_difference >= 0 THEN
        -- 逆分配: 先退其他来源, 仅超出部分逆减绑定周期 (不超过 amountToPeriod)
        v_balance_delta := v_difference;
        v_period_delta := -LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSE
        -- 超用吃绑定周期当前剩余额度 (credits_granted - consumed), 非 amountToPeriod 封顶
        v_overrun := p_actual_credits - v_pre_deducted;
        v_balance_delta := -v_overrun;
        v_period_delta := LEAST(v_overrun, GREATEST(v_grant_granted - v_grant_consumed, 0));
      END IF;
    END IF;

    IF v_period_delta <> 0 THEN
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_period_delta,
          updated_at = now()
      WHERE id = v_charged_grant_id;

      -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
      IF NOT FOUND THEN
        RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
      END IF;
    END IF;
  END IF;

  v_balance_after := v_current_balance + v_balance_delta;

  -- R6: SQL 侧非负余额守卫 (超用不得使 profiles.credits < 0)
  IF v_balance_after < 0 THEN
    RAISE EXCEPTION '积分不足: 结算将导致负余额 (当前 %, 变动 %)', v_current_balance, v_balance_delta;
  END IF;

  IF v_balance_delta <> 0 THEN
    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  END IF;

  -- 4. 插入结算记录
  INSERT INTO billing_history (
    user_id,
    operation_type,
    amount,
    reason,
    metadata
  ) VALUES (
    p_user_id,
    'settle',
    -p_actual_credits,
    'AI 对话结算',
    jsonb_build_object(
      'preDeductId', p_pre_deduct_id,
      'preDeductedAmount', v_pre_deducted,
      'actualCredits', p_actual_credits,
      'difference', v_difference,
      'usage', p_usage,
      'response', p_response,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other,
      'periodConsumedDelta', v_period_delta,
      'refundInterceptedOverrun', v_intercepted_overrun,
      'refundInterceptedRestoration', v_intercepted_restoration,
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT p_actual_credits, v_difference, v_balance_after;
END;
$$;

-- ============================================
-- 5. atomic_refund: binding-aware full restore
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_refund(
  p_user_id UUID,
  p_pre_deduct_id UUID,
  p_reason TEXT DEFAULT 'AI 调用失败退费'
)
RETURNS TABLE (
  refund_amount INTEGER,
  balance_after INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_refund_amount INTEGER;
  v_pre_meta JSONB;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  -- 1. 检查是否已处理
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE (metadata->>'preDeductId' = p_pre_deduct_id::TEXT)
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  -- 2. 获取预扣金额与绑定
  SELECT ABS(amount), metadata INTO v_refund_amount, v_pre_meta
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  -- 3. 锁定用户行 (锁序: profile -> grant)
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- 3a. R7: 持锁后复查重复处理 (唯一部分索引为最终硬屏障)
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE (metadata->>'preDeductId' = p_pre_deduct_id::TEXT)
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  v_balance_delta := v_refund_amount;

  -- 3b. REFUND-1B: 预扣完全未用, 按绑定逆分配返还
  v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
  IF v_charged_grant_id IS NOT NULL THEN
    v_period_key := v_pre_meta->>'chargedPeriodKey';
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
    SELECT g.status,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_terminated
    FROM subscription_credit_grants AS g
    JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
     AND us.user_id = p_user_id
    WHERE g.id = v_charged_grant_id
      AND g.user_id = p_user_id
      AND g.grant_period_key = v_period_key
    FOR UPDATE OF g;

    IF NOT FOUND THEN
      RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
    END IF;

    IF v_grant_status NOT IN ('granted', 'reversed') THEN
      RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
    END IF;

    v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

    IF v_intercepted THEN
      v_balance_delta := LEAST(v_refund_amount, GREATEST(v_to_other, 0));
      v_intercepted_restoration := LEAST(GREATEST(v_refund_amount - GREATEST(v_to_other, 0), 0), v_to_period);
    ELSE
      v_period_delta := -v_to_period;
    END IF;

    IF v_period_delta <> 0 THEN
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_period_delta,
          updated_at = now()
      WHERE id = v_charged_grant_id;

      -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
      IF NOT FOUND THEN
        RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
      END IF;
    END IF;
  END IF;

  v_balance_after := v_current_balance + v_balance_delta;

  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  -- 4. 插入退费记录
  INSERT INTO billing_history (
    user_id,
    operation_type,
    amount,
    reason,
    metadata
  ) VALUES (
    p_user_id,
    'refund',
    v_refund_amount,
    p_reason,
    jsonb_build_object(
      'preDeductId', p_pre_deduct_id,
      'refundAmount', v_refund_amount,
      'chargedGrantId', v_charged_grant_id,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other,
      'refundInterceptedRestoration', v_intercepted_restoration,
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT v_refund_amount, v_balance_after;
END;
$$;

-- ============================================
-- 6. atomic_abort_settle: binding-aware abort settlement
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_abort_settle(
  p_user_id UUID,
  p_pre_deduct_id UUID,
  p_consumed_credits INTEGER,
  p_consumed_tokens JSONB,
  p_model_id TEXT,
  p_reason TEXT DEFAULT '用户中断'
)
RETURNS TABLE (
  consumed_credits INTEGER,
  refunded_credits INTEGER,
  balance_after INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pre_deducted INTEGER;
  v_pre_meta JSONB;
  v_refunded INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_overrun INTEGER;
  v_intercepted_overrun INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  -- 1. 检查是否已处理
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE (metadata->>'preDeductId' = p_pre_deduct_id::TEXT)
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  -- 2. 获取预扣金额与绑定
  SELECT ABS(amount), metadata INTO v_pre_deducted, v_pre_meta
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  -- 3. 计算退还金额
  v_refunded := GREATEST(0, v_pre_deducted - p_consumed_credits);

  -- 4. 锁定用户行 (锁序: profile -> grant)
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- 4a. R7: 持锁后复查重复处理 (唯一部分索引为最终硬屏障)
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE (metadata->>'preDeductId' = p_pre_deduct_id::TEXT)
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  v_balance_delta := v_refunded;

  -- 4b. REFUND-1B: 按绑定逆分配返还 / 超用吃当期剩余
  v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
  IF v_charged_grant_id IS NOT NULL THEN
    v_period_key := v_pre_meta->>'chargedPeriodKey';
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
    SELECT g.status, g.credits_granted, g.consumed_amount,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_granted, v_grant_consumed, v_grant_terminated
    FROM subscription_credit_grants AS g
    JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
     AND us.user_id = p_user_id
    WHERE g.id = v_charged_grant_id
      AND g.user_id = p_user_id
      AND g.grant_period_key = v_period_key
    FOR UPDATE OF g;

    IF NOT FOUND THEN
      RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
    END IF;

    IF v_grant_status NOT IN ('granted', 'reversed') THEN
      RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
    END IF;

    v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

    IF v_intercepted THEN
      v_balance_delta := LEAST(v_refunded, GREATEST(v_to_other, 0));
      v_intercepted_restoration := LEAST(GREATEST(v_refunded - GREATEST(v_to_other, 0), 0), v_to_period);
      IF p_consumed_credits > v_pre_deducted THEN
        v_intercepted_overrun := p_consumed_credits - v_pre_deducted;
      END IF;
    ELSE
      IF v_refunded > 0 THEN
        v_balance_delta := v_refunded;
        v_period_delta := -LEAST(GREATEST(v_refunded - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSIF p_consumed_credits > v_pre_deducted THEN
        v_overrun := p_consumed_credits - v_pre_deducted;
        v_balance_delta := -v_overrun;
        v_period_delta := LEAST(v_overrun, GREATEST(v_grant_granted - v_grant_consumed, 0));
      END IF;
    END IF;

    IF v_period_delta <> 0 THEN
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_period_delta,
          updated_at = now()
      WHERE id = v_charged_grant_id;

      -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
      IF NOT FOUND THEN
        RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
      END IF;
    END IF;
  END IF;

  v_balance_after := v_current_balance + v_balance_delta;

  -- R6: SQL 侧非负余额守卫 (超用不得使 profiles.credits < 0)
  IF v_balance_after < 0 THEN
    RAISE EXCEPTION '积分不足: 中断结算将导致负余额 (当前 %, 变动 %)', v_current_balance, v_balance_delta;
  END IF;

  IF v_balance_delta <> 0 THEN
    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  END IF;

  -- 5. 插入中断结算记录
  INSERT INTO billing_history (
    user_id,
    operation_type,
    amount,
    reason,
    metadata
  ) VALUES (
    p_user_id,
    'abort_settle',
    -p_consumed_credits,
    p_reason,
    jsonb_build_object(
      'preDeductId', p_pre_deduct_id,
      'preDeductedAmount', v_pre_deducted,
      'consumedCredits', p_consumed_credits,
      'refundedCredits', v_refunded,
      'consumedTokens', p_consumed_tokens,
      'modelId', p_model_id,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other,
      'periodConsumedDelta', v_period_delta,
      'refundInterceptedOverrun', v_intercepted_overrun,
      'refundInterceptedRestoration', v_intercepted_restoration,
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT p_consumed_credits, v_refunded, v_balance_after;
END;
$$;

-- ============================================
-- 7. atomic_finalize_ai_success: pricing metadata + binding allocation
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_success(
  p_user_id UUID,
  p_conversation_id UUID,
  p_user_message TEXT,
  p_assistant_message TEXT,
  p_model_used TEXT,
  p_total_cost_usd NUMERIC(12, 6),
  p_total_credits INTEGER,
  p_pre_deduct_id UUID DEFAULT NULL,
  p_usage JSONB DEFAULT '{}'::JSONB,
  p_token_metadata JSONB DEFAULT '{}'::JSONB,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_search_count INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_message_id UUID,
  assistant_message_id UUID,
  transaction_id UUID,
  settle_id UUID,
  balance_after INTEGER,
  refunded_credits INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_message_id UUID;
  v_assistant_message_id UUID;
  v_transaction_id UUID;
  v_settle_id UUID;
  v_pre_deducted INTEGER := 0;
  v_pre_meta JSONB;
  v_difference INTEGER := 0;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
  v_pricing_metadata JSONB;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER := 0;
  v_period_delta INTEGER := 0;
  v_overrun INTEGER;
  v_intercepted_overrun INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  v_pricing_metadata := COALESCE(
    NULLIF(p_usage_metadata->'pricing', 'null'::JSONB),
    NULLIF(p_token_metadata->'pricing', 'null'::JSONB)
  );

  IF v_pricing_metadata IS NULL THEN
    SELECT jsonb_build_object(
      'modelId', p_model_used,
      'inputPer1M', (input_token_cost::NUMERIC / 1000000),
      'outputPer1M', (output_token_cost::NUMERIC / 1000000),
      'searchPer1K', (web_search_cost::NUMERIC / 1000000),
      'pricingSource', 'ai_models'
    )
    INTO v_pricing_metadata
    FROM ai_models
    WHERE model_id = p_model_used
    ORDER BY (is_active = 'true') DESC, updated_at DESC
    LIMIT 1;
  END IF;

  v_pricing_metadata := COALESCE(
    v_pricing_metadata,
    jsonb_build_object(
      'modelId', p_model_used,
      'inputPer1M', 0,
      'outputPer1M', 0,
      'searchPer1K', 0,
      'pricingSource', 'ai_models'
    )
  );

  IF p_pre_deduct_id IS NOT NULL THEN
    SELECT id INTO v_existing_process
    FROM billing_history
    WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
      AND operation_type IN ('settle', 'refund', 'abort_settle')
    LIMIT 1;

    IF v_existing_process IS NOT NULL THEN
      RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
    END IF;

    SELECT ABS(amount), metadata INTO v_pre_deducted, v_pre_meta
    FROM billing_history
    WHERE id = p_pre_deduct_id
      AND user_id = p_user_id
      AND operation_type = 'pre_deduct';

    IF NOT FOUND THEN
      RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
    END IF;

    v_difference := v_pre_deducted - p_total_credits;

    SELECT credits INTO v_current_balance
    FROM profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION '用户不存在: %', p_user_id;
    END IF;

    -- R7: 持锁后复查重复处理 (唯一部分索引为最终硬屏障)
    SELECT id INTO v_existing_process
    FROM billing_history
    WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
      AND operation_type IN ('settle', 'refund', 'abort_settle')
    LIMIT 1;

    IF v_existing_process IS NOT NULL THEN
      RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
    END IF;

    v_balance_delta := v_difference;

    -- REFUND-1B: 复用预扣绑定 (锁序 profile -> grant, 持锁重读状态)
    v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
    IF v_charged_grant_id IS NOT NULL THEN
      v_period_key := v_pre_meta->>'chargedPeriodKey';
      v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
      v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

      -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
      SELECT g.status, g.credits_granted, g.consumed_amount,
             (us.credit_release_terminated_at IS NOT NULL) AS terminated
      INTO v_grant_status, v_grant_granted, v_grant_consumed, v_grant_terminated
      FROM subscription_credit_grants AS g
      JOIN user_subscriptions AS us
        ON us.stripe_subscription_id = g.stripe_subscription_id
       AND us.user_id = p_user_id
      WHERE g.id = v_charged_grant_id
        AND g.user_id = p_user_id
        AND g.grant_period_key = v_period_key
      FOR UPDATE OF g;

      IF NOT FOUND THEN
        RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
      END IF;

      IF v_grant_status NOT IN ('granted', 'reversed') THEN
        RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
      END IF;

      v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

      IF v_intercepted THEN
        IF v_difference >= 0 THEN
          v_balance_delta := LEAST(v_difference, GREATEST(v_to_other, 0));
          v_intercepted_restoration := LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
        ELSE
          v_balance_delta := 0;
          v_intercepted_overrun := p_total_credits - v_pre_deducted;
        END IF;
      ELSE
        IF v_difference >= 0 THEN
          v_balance_delta := v_difference;
          v_period_delta := -LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
        ELSE
          v_overrun := p_total_credits - v_pre_deducted;
          v_balance_delta := -v_overrun;
          v_period_delta := LEAST(v_overrun, GREATEST(v_grant_granted - v_grant_consumed, 0));
        END IF;
      END IF;

      IF v_period_delta <> 0 THEN
        UPDATE subscription_credit_grants
        SET consumed_amount = consumed_amount + v_period_delta,
            updated_at = now()
        WHERE id = v_charged_grant_id;

        -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
        IF NOT FOUND THEN
          RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
        END IF;
      END IF;
    END IF;

    v_balance_after := v_current_balance + v_balance_delta;

    -- R6: SQL 侧非负余额守卫 (超用不得使 profiles.credits < 0)
    IF v_balance_after < 0 THEN
      RAISE EXCEPTION '积分不足: 结算将导致负余额 (当前 %, 变动 %)', v_current_balance, v_balance_delta;
    END IF;

    IF v_balance_delta <> 0 THEN
      UPDATE profiles
      SET credits = v_balance_after
      WHERE id = p_user_id;
    END IF;
  ELSE
    SELECT credits INTO v_balance_after
    FROM profiles
    WHERE id = p_user_id;
  END IF;

  INSERT INTO messages (conversation_id, role, content)
  VALUES (p_conversation_id, 'user', p_user_message)
  RETURNING id INTO v_user_message_id;

  INSERT INTO messages (conversation_id, role, content)
  VALUES (p_conversation_id, 'assistant', p_assistant_message)
  RETURNING id INTO v_assistant_message_id;

  IF p_total_credits > 0 THEN
    INSERT INTO credit_transactions (user_id, amount, type, description)
    VALUES (p_user_id, -p_total_credits, 'deduction', 'AI 对话消费')
    RETURNING id INTO v_transaction_id;
  END IF;

  IF p_pre_deduct_id IS NOT NULL THEN
    INSERT INTO billing_history (
      user_id,
      transaction_id,
      operation_type,
      amount,
      reason,
      metadata
    ) VALUES (
      p_user_id,
      v_transaction_id,
      'settle',
      -p_total_credits,
      'AI 对话结算',
      jsonb_build_object(
        'preDeductId', p_pre_deduct_id,
        'preDeductedAmount', v_pre_deducted,
        'actualCredits', p_total_credits,
        'difference', v_difference,
        'usage', p_usage,
        'requestId', p_request_id,
        'searchCount', p_search_count,
        'chargedGrantId', v_charged_grant_id,
        'chargedPeriodKey', v_period_key,
        'amountToPeriod', v_to_period,
        'amountToOther', v_to_other,
        'periodConsumedDelta', v_period_delta,
        'refundInterceptedOverrun', v_intercepted_overrun,
        'refundInterceptedRestoration', v_intercepted_restoration,
        'timestamp', NOW()::TEXT
      ) || COALESCE(p_token_metadata, '{}'::JSONB)
        || COALESCE(p_usage_metadata, '{}'::JSONB)
        || jsonb_build_object('pricing', v_pricing_metadata)
    )
    RETURNING id INTO v_settle_id;
  END IF;

  INSERT INTO token_stats (
    conversation_id,
    user_id,
    message_id,
    model_used,
    input_tokens,
    output_tokens,
    cached_tokens,
    cache_creation_tokens,
    web_search_count,
    total_cost_usd,
    total_credits,
    metadata
  ) VALUES (
    p_conversation_id,
    p_user_id,
    v_assistant_message_id,
    p_model_used,
    COALESCE((p_usage->>'inputTokens')::INTEGER, 0),
    COALESCE((p_usage->>'outputTokens')::INTEGER, 0),
    COALESCE((p_usage->>'cacheReadTokens')::INTEGER, 0),
    COALESCE((p_usage->>'cacheCreationTokens')::INTEGER, 0),
    COALESCE(p_search_count, 0),
    p_total_cost_usd,
    p_total_credits,
    COALESCE(p_token_metadata, '{}'::JSONB)
  );

  INSERT INTO ai_usage_logs (
    user_id,
    conversation_id,
    request_id,
    model_id,
    status,
    input_length,
    latency_ms,
    ip_address,
    user_agent,
    metadata
  ) VALUES (
    p_user_id,
    p_conversation_id,
    p_request_id,
    p_model_used,
    'success',
    p_input_length,
    p_latency_ms,
    p_ip_address,
    p_user_agent,
    COALESCE(p_usage_metadata, '{}'::JSONB)
  );

  RETURN QUERY SELECT
    v_user_message_id,
    v_assistant_message_id,
    v_transaction_id,
    v_settle_id,
    COALESCE(v_balance_after, 0),
    GREATEST(v_difference, 0);
END;
$$;

-- ============================================
-- 8. atomic_finalize_ai_failure: binding-aware full restore
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_failure(
  p_user_id UUID,
  p_model_used TEXT,
  p_reason TEXT,
  p_pre_deduct_id UUID DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  refund_amount INTEGER,
  balance_after INTEGER,
  transaction_id UUID,
  refund_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_refund_amount INTEGER := 0;
  v_pre_meta JSONB;
  v_current_balance INTEGER;
  v_balance_after INTEGER := 0;
  v_transaction_id UUID;
  v_refund_id UUID;
  v_existing_process UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  IF p_pre_deduct_id IS NOT NULL THEN
    SELECT id INTO v_existing_process
    FROM billing_history
    WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
      AND operation_type IN ('settle', 'refund', 'abort_settle')
    LIMIT 1;

    IF v_existing_process IS NOT NULL THEN
      RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
    END IF;

    SELECT ABS(amount), metadata INTO v_refund_amount, v_pre_meta
    FROM billing_history
    WHERE id = p_pre_deduct_id
      AND user_id = p_user_id
      AND operation_type = 'pre_deduct';

    IF NOT FOUND THEN
      RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
    END IF;

    SELECT credits INTO v_current_balance
    FROM profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION '用户不存在: %', p_user_id;
    END IF;

    -- R7: 持锁后复查重复处理 (唯一部分索引为最终硬屏障)
    SELECT id INTO v_existing_process
    FROM billing_history
    WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
      AND operation_type IN ('settle', 'refund', 'abort_settle')
    LIMIT 1;

    IF v_existing_process IS NOT NULL THEN
      RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
    END IF;

    v_balance_delta := v_refund_amount;

    -- REFUND-1B: 预扣完全未用, 按绑定逆分配返还 (锁序 profile -> grant)
    v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
    IF v_charged_grant_id IS NOT NULL THEN
      v_period_key := v_pre_meta->>'chargedPeriodKey';
      v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
      v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

      -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
      SELECT g.status,
             (us.credit_release_terminated_at IS NOT NULL) AS terminated
      INTO v_grant_status, v_grant_terminated
      FROM subscription_credit_grants AS g
      JOIN user_subscriptions AS us
        ON us.stripe_subscription_id = g.stripe_subscription_id
       AND us.user_id = p_user_id
      WHERE g.id = v_charged_grant_id
        AND g.user_id = p_user_id
        AND g.grant_period_key = v_period_key
      FOR UPDATE OF g;

      IF NOT FOUND THEN
        RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
      END IF;

      IF v_grant_status NOT IN ('granted', 'reversed') THEN
        RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
      END IF;

      v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

      IF v_intercepted THEN
        v_balance_delta := LEAST(v_refund_amount, GREATEST(v_to_other, 0));
        v_intercepted_restoration := LEAST(GREATEST(v_refund_amount - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSE
        v_period_delta := -v_to_period;
      END IF;

      IF v_period_delta <> 0 THEN
        UPDATE subscription_credit_grants
        SET consumed_amount = consumed_amount + v_period_delta,
            updated_at = now()
        WHERE id = v_charged_grant_id;

        -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
        IF NOT FOUND THEN
          RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
        END IF;
      END IF;
    END IF;

    v_balance_after := v_current_balance + v_balance_delta;

    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;

    IF v_refund_amount > 0 THEN
      INSERT INTO credit_transactions (user_id, amount, type, description)
      VALUES (p_user_id, v_refund_amount, 'refund', p_reason)
      RETURNING id INTO v_transaction_id;
    END IF;

    INSERT INTO billing_history (
      user_id,
      transaction_id,
      operation_type,
      amount,
      reason,
      metadata
    ) VALUES (
      p_user_id,
      v_transaction_id,
      'refund',
      v_refund_amount,
      p_reason,
      jsonb_build_object(
        'preDeductId', p_pre_deduct_id,
        'refundAmount', v_refund_amount,
        'requestId', p_request_id,
        'chargedGrantId', v_charged_grant_id,
        'amountToPeriod', v_to_period,
        'amountToOther', v_to_other,
        'refundInterceptedRestoration', v_intercepted_restoration,
        'timestamp', NOW()::TEXT
      ) || COALESCE(p_usage_metadata, '{}'::JSONB)
    )
    RETURNING id INTO v_refund_id;
  ELSE
    SELECT credits INTO v_balance_after
    FROM profiles
    WHERE id = p_user_id;
  END IF;

  INSERT INTO ai_usage_logs (
    user_id,
    conversation_id,
    request_id,
    model_id,
    status,
    error_message,
    input_length,
    latency_ms,
    ip_address,
    user_agent,
    metadata
  ) VALUES (
    p_user_id,
    p_conversation_id,
    p_request_id,
    p_model_used,
    'failed',
    p_reason,
    p_input_length,
    p_latency_ms,
    p_ip_address,
    p_user_agent,
    COALESCE(p_usage_metadata, '{}'::JSONB)
  );

  RETURN QUERY SELECT v_refund_amount, COALESCE(v_balance_after, 0), v_transaction_id, v_refund_id;
END;
$$;

-- ============================================
-- 9. atomic_finalize_ai_abort: binding-aware abort finalize
-- ============================================

CREATE OR REPLACE FUNCTION public.atomic_finalize_ai_abort(
  p_user_id UUID,
  p_conversation_id UUID,
  p_user_message TEXT,
  p_partial_assistant_message TEXT,
  p_model_used TEXT,
  p_total_cost_usd NUMERIC(12, 6),
  p_consumed_credits INTEGER,
  p_pre_deduct_id UUID,
  p_usage JSONB DEFAULT '{}'::JSONB,
  p_token_metadata JSONB DEFAULT '{}'::JSONB,
  p_usage_metadata JSONB DEFAULT '{}'::JSONB,
  p_request_id TEXT DEFAULT NULL,
  p_input_length INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_search_count INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_message_id UUID,
  assistant_message_id UUID,
  transaction_id UUID,
  abort_id UUID,
  balance_after INTEGER,
  refunded_credits INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_message_id UUID;
  v_assistant_message_id UUID;
  v_transaction_id UUID;
  v_abort_id UUID;
  v_pre_deducted INTEGER;
  v_pre_meta JSONB;
  v_refunded INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_overrun INTEGER;
  v_intercepted_overrun INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
BEGIN
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  SELECT ABS(amount), metadata INTO v_pre_deducted, v_pre_meta
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  v_refunded := GREATEST(0, v_pre_deducted - p_consumed_credits);

  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- R7: 持锁后复查重复处理 (唯一部分索引为最终硬屏障)
  SELECT id INTO v_existing_process
  FROM billing_history
  WHERE metadata->>'preDeductId' = p_pre_deduct_id::TEXT
    AND operation_type IN ('settle', 'refund', 'abort_settle')
  LIMIT 1;

  IF v_existing_process IS NOT NULL THEN
    RAISE EXCEPTION '该预扣记录已处理: %', p_pre_deduct_id;
  END IF;

  v_balance_delta := v_refunded;

  -- REFUND-1B: 按绑定逆分配返还 / 超用吃当期剩余 (锁序 profile -> grant)
  v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
  IF v_charged_grant_id IS NOT NULL THEN
    v_period_key := v_pre_meta->>'chargedPeriodKey';
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
    SELECT g.status, g.credits_granted, g.consumed_amount,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_granted, v_grant_consumed, v_grant_terminated
    FROM subscription_credit_grants AS g
      JOIN user_subscriptions AS us
        ON us.stripe_subscription_id = g.stripe_subscription_id
       AND us.user_id = p_user_id
      WHERE g.id = v_charged_grant_id
        AND g.user_id = p_user_id
        AND g.grant_period_key = v_period_key
    FOR UPDATE OF g;

    IF NOT FOUND THEN
      RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
    END IF;

    IF v_grant_status NOT IN ('granted', 'reversed') THEN
      RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
    END IF;

    v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;

    IF v_intercepted THEN
      v_balance_delta := LEAST(v_refunded, GREATEST(v_to_other, 0));
      v_intercepted_restoration := LEAST(GREATEST(v_refunded - GREATEST(v_to_other, 0), 0), v_to_period);
      IF p_consumed_credits > v_pre_deducted THEN
        v_intercepted_overrun := p_consumed_credits - v_pre_deducted;
      END IF;
    ELSE
      IF v_refunded > 0 THEN
        v_balance_delta := v_refunded;
        v_period_delta := -LEAST(GREATEST(v_refunded - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSIF p_consumed_credits > v_pre_deducted THEN
        v_overrun := p_consumed_credits - v_pre_deducted;
        v_balance_delta := -v_overrun;
        v_period_delta := LEAST(v_overrun, GREATEST(v_grant_granted - v_grant_consumed, 0));
      END IF;
    END IF;

    IF v_period_delta <> 0 THEN
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_period_delta,
          updated_at = now()
      WHERE id = v_charged_grant_id;

      -- R8: 持锁下的 UPDATE 必须命中且仅命中一行, 否则失败关闭
      IF NOT FOUND THEN
        RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
      END IF;
    END IF;
  END IF;

  v_balance_after := v_current_balance + v_balance_delta;

  -- R6: SQL 侧非负余额守卫 (超用不得使 profiles.credits < 0)
  IF v_balance_after < 0 THEN
    RAISE EXCEPTION '积分不足: 中断结算将导致负余额 (当前 %, 变动 %)', v_current_balance, v_balance_delta;
  END IF;

  IF v_balance_delta <> 0 THEN
    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  END IF;

  INSERT INTO messages (conversation_id, role, content)
  VALUES (p_conversation_id, 'user', p_user_message)
  RETURNING id INTO v_user_message_id;

  INSERT INTO messages (conversation_id, role, content)
  VALUES (p_conversation_id, 'assistant', p_partial_assistant_message)
  RETURNING id INTO v_assistant_message_id;

  IF p_consumed_credits > 0 THEN
    INSERT INTO credit_transactions (user_id, amount, type, description)
    VALUES (p_user_id, -p_consumed_credits, 'deduction', 'AI 对话中断结算')
    RETURNING id INTO v_transaction_id;
  END IF;

  INSERT INTO billing_history (
    user_id,
    transaction_id,
    operation_type,
    amount,
    reason,
    metadata
  ) VALUES (
    p_user_id,
    v_transaction_id,
    'abort_settle',
    -p_consumed_credits,
    'AI 对话中断结算',
    jsonb_build_object(
      'preDeductId', p_pre_deduct_id,
      'preDeductedAmount', v_pre_deducted,
      'consumedCredits', p_consumed_credits,
      'refundedCredits', v_refunded,
      'requestId', p_request_id,
      'searchCount', p_search_count,
      'usage', p_usage,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other,
      'periodConsumedDelta', v_period_delta,
      'refundInterceptedOverrun', v_intercepted_overrun,
      'refundInterceptedRestoration', v_intercepted_restoration,
      'timestamp', NOW()::TEXT
    ) || COALESCE(p_token_metadata, '{}'::JSONB) || COALESCE(p_usage_metadata, '{}'::JSONB)
  )
  RETURNING id INTO v_abort_id;

  INSERT INTO token_stats (
    conversation_id,
    user_id,
    message_id,
    model_used,
    input_tokens,
    output_tokens,
    cached_tokens,
    cache_creation_tokens,
    web_search_count,
    total_cost_usd,
    total_credits,
    metadata
  ) VALUES (
    p_conversation_id,
    p_user_id,
    v_assistant_message_id,
    p_model_used,
    COALESCE((p_usage->>'inputTokens')::INTEGER, 0),
    COALESCE((p_usage->>'outputTokens')::INTEGER, 0),
    COALESCE((p_usage->>'cacheReadTokens')::INTEGER, 0),
    COALESCE((p_usage->>'cacheCreationTokens')::INTEGER, 0),
    COALESCE(p_search_count, 0),
    p_total_cost_usd,
    p_consumed_credits,
    COALESCE(p_token_metadata, '{}'::JSONB)
  );

  INSERT INTO ai_usage_logs (
    user_id,
    conversation_id,
    request_id,
    model_id,
    status,
    error_message,
    input_length,
    latency_ms,
    ip_address,
    user_agent,
    metadata
  ) VALUES (
    p_user_id,
    p_conversation_id,
    p_request_id,
    p_model_used,
    'failed',
    'stream_aborted',
    p_input_length,
    p_latency_ms,
    p_ip_address,
    p_user_agent,
    COALESCE(p_usage_metadata, '{}'::JSONB)
  );

  RETURN QUERY SELECT
    v_user_message_id,
    v_assistant_message_id,
    v_transaction_id,
    v_abort_id,
    v_balance_after,
    v_refunded;
END;
$$;

-- ============================================
-- 10. atomic_refund_termination_clawback: unified refund transaction (R2/R5)
-- ============================================
-- One transaction (profiles FOR UPDATE -> subscription_credit_grants FOR
-- UPDATE) that:
--   * writes the credit-release termination FIRST with a first-event-wins
--     guard and FAILS CLOSED when the user_subscriptions mirror row is
--     missing (no grant reversal, no clawback may proceed);
--   * re-reads the located period grant under the profile->grant lock,
--     failing closed when the grant row is missing/deleted or in an
--     unexpected status;
--   * reverses exactly the located period grant (guarded on status);
--   * claws back credits_granted - consumed_amount bounded by the current
--     balance (LEAST), so profiles.credits can never go negative;
--   * serializes replay/concurrent callers through a post-lock recheck of
--     the canonical event_id + subscription_id + period_key idempotency key
--     (backed by idx_credit_transactions_user_idempotency_key).
-- p_termination_only = TRUE (or p_period_key IS NULL) stops after the
-- termination write: REVIEW_REQUIRED flows must stop future releases
-- without guessing a deduction.

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
    SET credits = v_balance_before - v_applied,
        updated_at = v_now
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

-- ============================================
-- 10a. atomic_refund_termination_clawback_fresh: locked refund resolution
-- ============================================
-- The application-level grant snapshot is deliberately not authoritative.
-- This candidate-new wrapper takes the same profile -> subscription -> grant
-- barrier as annual admission, resolves the trusted period while those locks
-- are held, and calls the existing refund transaction before releasing them.
-- Therefore a grant committed before this refund transaction obtains the
-- profile lock is visible to the refund, while an annual admission that loses
-- the lock race observes the committed termination and is blocked.

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

  -- Lock order is profile -> subscription -> grant. No period or termination
  -- decision below may rely on the pre-lock application snapshot.
  PERFORM credits
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

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

  -- R4/V8: resolve only from trusted refund time + exactly one complete,
  -- canonical grant window of the freshly locked authoritative term.
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
      SELECT g.user_id,
             g.stripe_subscription_id,
             g.membership_plan_id,
             g.billing_cycle,
             g.grant_type,
             g.period_index,
             g.total_periods,
             g.period_start,
             g.period_end,
             g.grant_period_key,
             g.stripe_invoice_id,
             g.status
      INTO v_grant_user_id, v_grant_subscription_id, v_grant_membership_plan_id,
           v_grant_billing_cycle, v_grant_type, v_period_index, v_total_periods,
           v_period_start, v_period_end, v_period_key, v_grant_stripe_invoice_id,
           v_grant_status
      FROM subscription_credit_grants AS g
      WHERE g.stripe_subscription_id = p_subscription_id
        AND g.period_start <= p_refund_created_at
        AND p_refund_created_at < g.period_end
      FOR UPDATE;

      IF NOT COALESCE(public.refund_1b_is_canonical_period_identity(
        p_user_id,
        p_subscription_id,
        v_term_membership_plan_id,
        v_term_billing_cycle,
        v_term_start,
        v_term_end,
        v_grant_user_id,
        v_grant_subscription_id,
        v_grant_membership_plan_id,
        v_grant_billing_cycle,
        v_grant_type,
        v_period_key,
        v_period_start,
        v_period_end,
        v_period_index,
        v_total_periods,
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

  -- Keep the existing public signature untouched. The call is in this same
  -- transaction, while the profile/subscription/grant barrier remains held.
  RETURN QUERY
  SELECT refund.transaction_id,
         refund.balance_after,
         refund.clawback_amount,
         refund.applied_clawback_amount,
         refund.shortfall_amount,
         refund.already_applied,
         refund.termination_written,
         refund.already_terminated,
         refund.grant_reversed,
         refund.already_reversed,
         refund.credits_granted,
         refund.consumed_amount,
         v_period_key,
         v_termination_only,
         v_review_reason,
         v_idempotency_key
  FROM public.atomic_refund_termination_clawback(
    p_user_id,
    p_subscription_id,
    p_event_id,
    v_period_key,
    v_idempotency_key,
    p_reason,
    v_termination_only,
    p_refund_id,
    p_now
  ) AS refund;
END;
$$;

-- ============================================
-- 10b. atomic_grant_annual_subscription_credits: termination-aware annual admission
-- ============================================
-- The cron-side subscription snapshot is only an eligibility hint. This RPC is
-- the authoritative admission barrier for annual releases: it locks the
-- profile first, then the subscription mirror, re-reads termination while the
-- lock is held, and writes the credit transaction plus grant row in one
-- transaction. A refund using the same profile -> subscription lock order
-- therefore either commits termination first (the grant is blocked) or lets
-- the already-committed grant be observed by the later refund transaction.

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
  SET credits = v_balance_after,
      updated_at = v_now
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



-- ============================================
-- 10c. atomic_grant_subscription_invoice_credits: invoice money-lane barrier
-- ============================================
-- Invoice fulfillment must not use an application pre-read as its admission
-- decision. This candidate-only helper locks profile -> source/invoice order
-- -> subscription mirror, then either observes committed refund posture or
-- commits the ledger, durable grant, mirror, and invoice completion together.
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
      membership_level = COALESCE(NULLIF(btrim(p_membership_level), ''), membership_level),
      updated_at = v_now
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

-- V8: the legacy privileged writer can directly credit a profile without a
-- subscription_credit_grants row or REFUND-1B termination barrier. Keep its
-- public signature and service-role posture for compatibility, but fail
-- closed so all membership invoice fulfillment uses the canonical precise
-- invoice admission above.
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
BEGIN
  RAISE EXCEPTION 'LEGACY_MEMBERSHIP_INVOICE_FULFILLMENT_RETIRED_USE_CANONICAL_PRECISE_ADMISSION';
END;
$$;

-- ============================================
-- 11. SEC-1 posture closure for every replaced/added function
-- ============================================

DO $$
DECLARE
  v_signature text;
  v_service_role_only constant text[] := ARRAY[
    'public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)',
    'public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
    'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
    'public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
    'public.atomic_fulfill_membership_invoice(text,text,integer,text,text,text,timestamptz,timestamptz)',
    'public.atomic_grant_annual_subscription_credits(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,text,text,uuid,jsonb,jsonb,timestamptz)',
    'public.atomic_grant_subscription_invoice_credits(uuid,uuid,text,text,uuid,integer,text,text,text,text,timestamptz,timestamptz,integer,integer,integer,text,text,boolean,text,text,text,text,text,jsonb,jsonb,timestamptz)',
    'public.atomic_pre_deduct(uuid,integer,text,uuid)',
    'public.refund_1b_is_canonical_period_identity(uuid,text,uuid,text,timestamptz,timestamptz,uuid,text,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text)',
    'public.atomic_refund(uuid,uuid,text)',
    'public.atomic_refund_termination_clawback_fresh(uuid,text,text,timestamptz,text,text,text,timestamptz)',
    'public.atomic_refund_termination_clawback(uuid,text,text,text,text,text,boolean,text,timestamptz)',
    'public.atomic_settle(uuid,uuid,integer,jsonb,jsonb)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_service_role_only LOOP
    IF to_regprocedure(v_signature) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
    ELSE
      RAISE EXCEPTION 'REFUND-1B SEC-1 closure expected function missing: %', v_signature;
    END IF;
  END LOOP;
END
$$;

COMMENT ON CONSTRAINT subscription_credit_grants_consumed_amount_check
  ON public.subscription_credit_grants
  IS 'REFUND-1B invariant: per-period consumption never negative and never exceeds credits_granted';
