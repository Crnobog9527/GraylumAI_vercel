-- Migration: 原子化计费 RPC 函数
-- Version: 0003
-- Date: 2026-01-21
-- Description: 修复 Phase 10 审计发现的计费事务非原子性问题 (P0-6)

-- ============================================
-- 1. 原子化预扣函数
-- ============================================

CREATE OR REPLACE FUNCTION atomic_pre_deduct(
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
AS $$
DECLARE
  v_pre_deduct_id UUID;
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_existing_id UUID;
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
      -- 返回已存在的记录
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

  -- 2. 锁定用户行并获取当前余额 (FOR UPDATE 确保原子性)
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

  -- 5. 插入预扣记录
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
      'requestId', p_request_id
    )
  )
  RETURNING id INTO v_pre_deduct_id;

  RETURN QUERY SELECT v_pre_deduct_id, v_balance_before, v_balance_after, FALSE;
END;
$$;

-- ============================================
-- 2. 原子化结算函数
-- ============================================

CREATE OR REPLACE FUNCTION atomic_settle(
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
AS $$
DECLARE
  v_pre_deducted INTEGER;
  v_difference INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_settle UUID;
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

  -- 2. 获取预扣记录并验证
  SELECT ABS(amount) INTO v_pre_deducted
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  v_difference := v_pre_deducted - p_actual_credits;

  -- 3. 锁定用户行并处理差额
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF v_difference != 0 THEN
    v_balance_after := v_current_balance + v_difference; -- 正数退还，负数补扣

    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  ELSE
    v_balance_after := v_current_balance;
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
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT p_actual_credits, v_difference, v_balance_after;
END;
$$;

-- ============================================
-- 3. 原子化退费函数
-- ============================================

CREATE OR REPLACE FUNCTION atomic_refund(
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
AS $$
DECLARE
  v_refund_amount INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
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

  -- 2. 获取预扣金额
  SELECT ABS(amount) INTO v_refund_amount
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  -- 3. 锁定用户行并退还积分
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  v_balance_after := v_current_balance + v_refund_amount;

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
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT v_refund_amount, v_balance_after;
END;
$$;

-- ============================================
-- 4. 原子化中断结算函数
-- ============================================

CREATE OR REPLACE FUNCTION atomic_abort_settle(
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
AS $$
DECLARE
  v_pre_deducted INTEGER;
  v_refunded INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
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

  -- 2. 获取预扣金额
  SELECT ABS(amount) INTO v_pre_deducted
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';

  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;

  -- 3. 计算退还金额
  v_refunded := GREATEST(0, v_pre_deducted - p_consumed_credits);

  -- 4. 锁定用户行并退还未使用的积分
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF v_refunded > 0 THEN
    v_balance_after := v_current_balance + v_refunded;

    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  ELSE
    v_balance_after := v_current_balance;
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
      'timestamp', NOW()::TEXT
    )
  );

  RETURN QUERY SELECT p_consumed_credits, v_refunded, v_balance_after;
END;
$$;

-- ============================================
-- 5. 注释说明
-- ============================================

COMMENT ON FUNCTION atomic_pre_deduct IS '原子化预扣积分，使用 FOR UPDATE 锁确保并发安全';
COMMENT ON FUNCTION atomic_settle IS '原子化结算，处理预扣与实际消耗的差额';
COMMENT ON FUNCTION atomic_refund IS '原子化退费，请求失败时全额退还预扣积分';
COMMENT ON FUNCTION atomic_abort_settle IS '原子化中断结算，用户中断时按实际消耗计费';
