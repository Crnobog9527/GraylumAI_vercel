-- REFUND-1B forward-only repair: caller-supplied token/usage metadata must
-- never override authoritative settlement identity or refund accounting.
-- Applied migrations 0053-0057 remain immutable.

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
      COALESCE(p_token_metadata, '{}'::JSONB)
        || COALESCE(p_usage_metadata, '{}'::JSONB)
        || jsonb_build_object(
          'preDeductId', p_pre_deduct_id,
          'preDeductedAmount', v_pre_deducted,
          'actualCredits', p_total_credits,
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
          'timestamp', NOW()::TEXT,
          'pricing', v_pricing_metadata,
          'difference', v_balance_delta,
          'requestedDifference', v_difference,
          'refundedCredits', GREATEST(v_balance_delta, 0),
          'requestedRefundedCredits', GREATEST(v_difference, 0)
        )
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
    GREATEST(v_balance_delta, 0);
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

    IF GREATEST(v_balance_delta, 0) > 0 THEN
      INSERT INTO credit_transactions (user_id, amount, type, description)
      VALUES (p_user_id, GREATEST(v_balance_delta, 0), 'refund', p_reason)
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
      GREATEST(v_balance_delta, 0),
      p_reason,
      COALESCE(p_usage_metadata, '{}'::JSONB)
        || jsonb_build_object(
          'preDeductId', p_pre_deduct_id,
          'requestId', p_request_id,
          'chargedGrantId', v_charged_grant_id,
          'amountToPeriod', v_to_period,
          'amountToOther', v_to_other,
          'refundInterceptedRestoration', v_intercepted_restoration,
          'timestamp', NOW()::TEXT,
          'refundAmount', GREATEST(v_balance_delta, 0),
          'requestedRefundAmount', v_refund_amount
        )
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

  RETURN QUERY SELECT GREATEST(COALESCE(v_balance_delta, 0), 0), COALESCE(v_balance_after, 0), v_transaction_id, v_refund_id;
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
    COALESCE(p_token_metadata, '{}'::JSONB)
      || COALESCE(p_usage_metadata, '{}'::JSONB)
      || jsonb_build_object(
        'preDeductId', p_pre_deduct_id,
        'preDeductedAmount', v_pre_deducted,
        'consumedCredits', p_consumed_credits,
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
        'timestamp', NOW()::TEXT,
        'refundedCredits', GREATEST(v_balance_delta, 0),
        'requestedRefundedCredits', v_refunded
      )
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
    GREATEST(v_balance_delta, 0);
END;
$$;

-- Preserve the exact service-role-only execution posture of the three
-- replaced SECURITY DEFINER functions.
DO $$
DECLARE
  v_signature text;
  v_service_role_only constant text[] := ARRAY[
    'public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
    'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
    'public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_service_role_only LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'REFUND-1B 0058 expected function missing: %', v_signature;
    END IF;

    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END
$$;
