-- REFUND-1B forward-only repair: failure finalization must preserve the
-- trusted pre-deduct period binding over caller-supplied usage metadata.
-- Applied migrations 0053-0058 remain immutable.

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
          'chargedPeriodKey', v_period_key,
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

-- Preserve the exact service-role-only execution posture of the replaced
-- SECURITY DEFINER function.
DO $$
DECLARE
  v_signature text;
  v_service_role_only constant text[] := ARRAY[
    'public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_service_role_only LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'REFUND-1B 0059 expected function missing: %', v_signature;
    END IF;

    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END
$$;
