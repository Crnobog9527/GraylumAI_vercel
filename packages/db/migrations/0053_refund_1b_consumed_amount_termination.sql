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
  SELECT g.id, g.grant_period_key, g.credits_granted, g.consumed_amount
  INTO v_charged_grant_id, v_period_key, v_grant_granted, v_grant_consumed
  FROM subscription_credit_grants AS g
  WHERE g.user_id = p_user_id
    AND g.status = 'granted'
    AND g.period_start <= now()
    AND g.period_end > now()
    AND NOT EXISTS (
      SELECT 1
      FROM user_subscriptions AS us
      WHERE us.stripe_subscription_id = g.stripe_subscription_id
        AND us.credit_release_terminated_at IS NOT NULL
    )
  ORDER BY g.period_start DESC, g.created_at DESC
  LIMIT 1
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
    LEFT JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
    WHERE g.id = v_charged_grant_id
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
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
    SELECT g.status,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_terminated
    FROM subscription_credit_grants AS g
    LEFT JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
    WHERE g.id = v_charged_grant_id
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
    LEFT JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
    WHERE g.id = v_charged_grant_id
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
      LEFT JOIN user_subscriptions AS us
        ON us.stripe_subscription_id = g.stripe_subscription_id
      WHERE g.id = v_charged_grant_id
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
      v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
      v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

      -- R3/R8: 持锁重读 grant + 订阅 termination 状态; 行缺失/状态异常即失败关闭
      SELECT g.status,
             (us.credit_release_terminated_at IS NOT NULL) AS terminated
      INTO v_grant_status, v_grant_terminated
      FROM subscription_credit_grants AS g
      LEFT JOIN user_subscriptions AS us
        ON us.stripe_subscription_id = g.stripe_subscription_id
      WHERE g.id = v_charged_grant_id
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
    LEFT JOIN user_subscriptions AS us
      ON us.stripe_subscription_id = g.stripe_subscription_id
    WHERE g.id = v_charged_grant_id
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
BEGIN
  IF btrim(COALESCE(p_subscription_id, '')) = '' THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  v_full_mode := (p_termination_only IS NOT TRUE) AND (btrim(COALESCE(p_period_key, '')) <> '');

  IF v_full_mode THEN
    IF btrim(COALESCE(p_idempotency_key, '')) = '' THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_CANONICAL_IDEMPOTENCY_KEY_REQUIRED';
    END IF;

    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_USER_REQUIRED';
    END IF;

    -- R2: 锁序 profile -> grant; 该锁也是并发退款/结算调用的串行化点
    SELECT credits INTO v_balance_before
    FROM profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_PROFILE_MISSING: %', p_user_id;
    END IF;

    -- R1: 持锁后复查 canonical (event_id + subscription_id + period_key) 幂等键;
    --     唯一索引 idx_credit_transactions_user_idempotency_key 是最终硬屏障
    SELECT ct.id, ct.balance_after, ABS(ct.amount) AS applied_amount
    INTO v_existing_transaction
    FROM credit_transactions AS ct
    WHERE ct.user_id = p_user_id
      AND ct.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_transaction.id,
        v_existing_transaction.balance_after,
        0,
        v_existing_transaction.applied_amount,
        0,
        TRUE,
        FALSE,
        FALSE,
        FALSE,
        FALSE,
        NULL::INTEGER,
        NULL::INTEGER;
      RETURN;
    END IF;
  END IF;

  -- R5: 先写 termination (首个成功事件确立); mirror 缺失即失败关闭,
  --     不得继续 grant reversal / clawback
  UPDATE user_subscriptions
  SET credit_release_terminated_at = v_now,
      credit_release_terminated_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'stripe_refund'),
      credit_release_terminated_event_id = p_event_id,
      credit_release_terminated_period_key = p_period_key,
      updated_at = v_now
  WHERE stripe_subscription_id = p_subscription_id
    AND credit_release_terminated_at IS NULL
  RETURNING id INTO v_mirror_id;

  IF v_mirror_id IS NOT NULL THEN
    v_termination_written := TRUE;
  ELSE
    SELECT id INTO v_mirror_id
    FROM user_subscriptions
    WHERE stripe_subscription_id = p_subscription_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_CLAWBACK_SUBSCRIPTION_MIRROR_MISSING: %', p_subscription_id;
    END IF;
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
  WHERE g.stripe_subscription_id = p_subscription_id
    AND g.grant_period_key = p_period_key
  ORDER BY g.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_MISSING: % / %', p_subscription_id, p_period_key;
  END IF;

  IF v_grant_status NOT IN ('granted', 'reversed') THEN
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_UNEXPECTED_STATUS: % (%)', v_period_key, v_grant_status;
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
    RAISE EXCEPTION 'REFUND_CLAWBACK_GRANT_REVERSAL_RACE: %', v_period_key;
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

    INSERT INTO credit_transactions (
      user_id,
      amount,
      type,
      description,
      idempotency_key,
      balance_before,
      balance_after
    ) VALUES (
      p_user_id,
      -v_applied,
      'deduction',
      format(
        'Stripe subscription refund credit clawback [subscription:%s refund:%s grants:1]',
        p_subscription_id,
        COALESCE(NULLIF(btrim(COALESCE(p_refund_id, '')), ''), 'unknown')
      ),
      p_idempotency_key,
      v_balance_before,
      v_balance_before - v_applied
    )
    RETURNING id INTO v_transaction_id;
  END IF;

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
    'public.atomic_pre_deduct(uuid,integer,text,uuid)',
    'public.atomic_refund(uuid,uuid,text)',
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
