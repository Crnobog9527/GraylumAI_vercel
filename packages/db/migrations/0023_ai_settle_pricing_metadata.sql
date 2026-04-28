-- Ensure AI settle billing_history metadata always carries the pricing snapshot.
-- This changes metadata observability only; billing math and balance updates are unchanged.

CREATE OR REPLACE FUNCTION atomic_finalize_ai_success(
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
AS $$
DECLARE
  v_user_message_id UUID;
  v_assistant_message_id UUID;
  v_transaction_id UUID;
  v_settle_id UUID;
  v_pre_deducted INTEGER := 0;
  v_difference INTEGER := 0;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
  v_pricing_metadata JSONB;
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

    SELECT ABS(amount) INTO v_pre_deducted
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

    v_balance_after := v_current_balance + v_difference;

    IF v_difference != 0 THEN
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

ALTER FUNCTION public.atomic_finalize_ai_success(
  UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INTEGER, UUID, JSONB, JSONB, JSONB, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT
) SET search_path = public, pg_temp;
