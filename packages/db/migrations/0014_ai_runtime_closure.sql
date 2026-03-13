-- Migration: AI runtime closure and atomic AI finalize functions
-- Version: 0014
-- Date: 2026-03-10
-- Description: closes routing/token-counting/accounting gaps for production AI runtime

-- ============================================
-- 1. Schema alignment
-- ============================================

ALTER TABLE billing_history
  DROP CONSTRAINT IF EXISTS billing_history_operation_type_check;

ALTER TABLE billing_history
  ADD CONSTRAINT billing_history_operation_type_check
  CHECK (operation_type IN ('pre_deduct', 'settle', 'refund', 'abort_settle'));

ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS token_counting_supported TEXT NOT NULL DEFAULT 'false',
  ADD COLUMN IF NOT EXISTS token_counting_method TEXT NOT NULL DEFAULT 'unsupported',
  ADD COLUMN IF NOT EXISTS tokenizer_family TEXT;

ALTER TABLE token_stats
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE TABLE IF NOT EXISTS conversation_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('rolling_summary', 'search_digest', 'compression_checkpoint')),
  content TEXT NOT NULL,
  source_message_start_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_message_end_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_snapshots_conversation_type
  ON conversation_context_snapshots(conversation_id, snapshot_type);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation_created
  ON conversation_context_snapshots(conversation_id, created_at DESC);

COMMENT ON TABLE conversation_context_snapshots IS 'Versioned runtime context artifacts used by smart routing, search summaries, and compression checkpoints';

UPDATE ai_models
SET
  token_counting_supported = CASE
    WHEN provider IN ('anthropic', 'google') THEN 'true'
    WHEN provider IN ('openai', 'custom') THEN 'true'
    ELSE 'false'
  END,
  token_counting_method = CASE
    WHEN provider = 'anthropic' THEN 'anthropic_count_tokens'
    WHEN provider = 'google' THEN 'gemini_count_tokens'
    WHEN provider IN ('openai', 'custom') THEN 'provider_usage'
    ELSE 'unsupported'
  END,
  tokenizer_family = CASE
    WHEN provider = 'anthropic' THEN 'anthropic'
    WHEN provider = 'google' THEN 'gemini'
    WHEN provider = 'openai' THEN 'openai'
    WHEN provider = 'custom' AND (
      COALESCE(api_endpoint, '') ILIKE '%openrouter%'
      OR COALESCE(api_endpoint, '') ILIKE '%chat/completions%'
    ) THEN 'openai'
    ELSE tokenizer_family
  END
WHERE
  COALESCE(token_counting_method, 'unsupported') = 'unsupported'
  OR COALESCE(tokenizer_family, '') = '';

-- ============================================
-- 2. Atomic finalize success
-- ============================================

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
      ) || COALESCE(p_token_metadata, '{}'::JSONB) || COALESCE(p_usage_metadata, '{}'::JSONB)
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
-- 3. Atomic finalize failure
-- ============================================

CREATE OR REPLACE FUNCTION atomic_finalize_ai_failure(
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
AS $$
DECLARE
  v_refund_amount INTEGER := 0;
  v_current_balance INTEGER;
  v_balance_after INTEGER := 0;
  v_transaction_id UUID;
  v_refund_id UUID;
  v_existing_process UUID;
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

    SELECT ABS(amount) INTO v_refund_amount
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

    v_balance_after := v_current_balance + v_refund_amount;

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
-- 4. Atomic finalize abort
-- ============================================

CREATE OR REPLACE FUNCTION atomic_finalize_ai_abort(
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
AS $$
DECLARE
  v_user_message_id UUID;
  v_assistant_message_id UUID;
  v_transaction_id UUID;
  v_abort_id UUID;
  v_pre_deducted INTEGER;
  v_refunded INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_process UUID;
BEGIN
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

  v_refunded := GREATEST(0, v_pre_deducted - p_consumed_credits);

  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  v_balance_after := v_current_balance + v_refunded;

  IF v_refunded > 0 THEN
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
    (COALESCE(p_usage_metadata, '{}'::JSONB) || jsonb_build_object('aborted', true))
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

COMMENT ON FUNCTION atomic_finalize_ai_success IS 'Finalize a successful AI response in one database transaction, including billing, messages, token stats, and usage logs';
COMMENT ON FUNCTION atomic_finalize_ai_failure IS 'Finalize a failed AI response in one database transaction, including refund and usage log';
COMMENT ON FUNCTION atomic_finalize_ai_abort IS 'Finalize an aborted AI response in one database transaction, including partial message persistence and proportional billing';
