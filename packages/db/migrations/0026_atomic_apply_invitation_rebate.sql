-- Migration: atomic invitation spend rebate
-- Description: Applies invitation consumption rebates atomically with stable ledger idempotency.

CREATE OR REPLACE FUNCTION atomic_apply_invitation_rebate(
  p_invitee_id UUID,
  p_consumed_credits INTEGER,
  p_pre_deduct_id TEXT,
  p_rebate_percent INTEGER,
  p_daily_reward_limit INTEGER DEFAULT 0,
  p_total_reward_limit INTEGER DEFAULT 0,
  p_binding_cutoff TIMESTAMPTZ DEFAULT NULL,
  p_day_start TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  status TEXT,
  invitation_record_id UUID,
  inviter_id UUID,
  rebate_amount INTEGER,
  balance_before INTEGER,
  balance_after INTEGER,
  transaction_id UUID,
  idempotency_key TEXT,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pre_deduct_id TEXT := btrim(p_pre_deduct_id);
  v_expected_idempotency_key TEXT;
  v_idempotency_key TEXT;
  v_invitation_record RECORD;
  v_existing_transaction RECORD;
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_raw_rebate_amount INTEGER;
  v_rebate_amount INTEGER;
  v_inviter_rewarded_today INTEGER := 0;
  v_inviter_rewarded_total INTEGER := 0;
  v_remaining_daily INTEGER;
  v_remaining_total INTEGER;
  v_transaction_id UUID;
  v_description TEXT;
BEGIN
  IF p_invitee_id IS NULL THEN
    RAISE EXCEPTION 'invitee_id is required';
  END IF;

  IF v_pre_deduct_id IS NULL OR v_pre_deduct_id = '' THEN
    RAISE EXCEPTION 'pre_deduct_id is required';
  END IF;

  v_expected_idempotency_key := format('invitation_rebate:%s', v_pre_deduct_id);
  v_idempotency_key := COALESCE(NULLIF(btrim(p_idempotency_key), ''), v_expected_idempotency_key);

  IF v_idempotency_key <> v_expected_idempotency_key THEN
    RAISE EXCEPTION 'invalid invitation rebate idempotency key: expected %, got %',
      v_expected_idempotency_key,
      v_idempotency_key;
  END IF;

  IF COALESCE(p_consumed_credits, 0) <= 0 THEN
    RETURN QUERY SELECT
      'zero_consumption'::TEXT,
      NULL::UUID,
      NULL::UUID,
      0,
      NULL::INTEGER,
      NULL::INTEGER,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  IF COALESCE(p_rebate_percent, 0) <= 0 THEN
    RETURN QUERY SELECT
      'disabled'::TEXT,
      NULL::UUID,
      NULL::UUID,
      0,
      NULL::INTEGER,
      NULL::INTEGER,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  IF COALESCE(p_daily_reward_limit, 0) < 0 OR COALESCE(p_total_reward_limit, 0) < 0 THEN
    RAISE EXCEPTION 'invitation rebate caps must be non-negative';
  END IF;

  IF COALESCE(p_daily_reward_limit, 0) > 0 AND p_day_start IS NULL THEN
    RAISE EXCEPTION 'day_start is required when daily invitation rebate cap is enabled';
  END IF;

  SELECT ir.id, ir.inviter_id, ir.invitee_email
  INTO v_invitation_record
  FROM invitation_records AS ir
  WHERE ir.invitee_id = p_invitee_id
    AND ir.inviter_id IS NOT NULL
    AND ir.status = 'rewarded'
    AND (p_binding_cutoff IS NULL OR ir.created_at >= p_binding_cutoff)
  ORDER BY ir.created_at DESC, ir.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'no_binding'::TEXT,
      NULL::UUID,
      NULL::UUID,
      0,
      NULL::INTEGER,
      NULL::INTEGER,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  SELECT p.credits
  INTO v_balance_before
  FROM profiles AS p
  WHERE p.id = v_invitation_record.inviter_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'no_binding'::TEXT,
      v_invitation_record.id,
      v_invitation_record.inviter_id,
      0,
      NULL::INTEGER,
      NULL::INTEGER,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  SELECT ct.id, ct.amount, ct.balance_before, ct.balance_after
  INTO v_existing_transaction
  FROM credit_transactions AS ct
  WHERE ct.user_id = v_invitation_record.inviter_id
    AND ct.idempotency_key = v_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      'already_applied'::TEXT,
      v_invitation_record.id,
      v_invitation_record.inviter_id,
      COALESCE(v_existing_transaction.amount, 0),
      v_existing_transaction.balance_before,
      v_existing_transaction.balance_after,
      v_existing_transaction.id,
      v_idempotency_key,
      TRUE;
    RETURN;
  END IF;

  v_raw_rebate_amount := FLOOR((p_consumed_credits::NUMERIC * p_rebate_percent::NUMERIC) / 100)::INTEGER;

  IF v_raw_rebate_amount <= 0 THEN
    RETURN QUERY SELECT
      'below_minimum'::TEXT,
      v_invitation_record.id,
      v_invitation_record.inviter_id,
      0,
      v_balance_before,
      v_balance_before,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  SELECT
    COALESCE((
      SELECT SUM(ir.inviter_reward)
      FROM invitation_records AS ir
      WHERE ir.inviter_id = v_invitation_record.inviter_id
        AND ir.status = 'rewarded'
        AND ir.created_at >= p_day_start
    ), 0) + COALESCE((
      SELECT SUM(ct.amount)
      FROM credit_transactions AS ct
      WHERE ct.user_id = v_invitation_record.inviter_id
        AND ct.type = 'addition'
        AND ct.amount > 0
        AND (
          ct.idempotency_key LIKE 'invitation_rebate:%'
          OR (
            ct.idempotency_key IS NULL
            AND ct.description LIKE '邀请消费返利（结算 %'
          )
        )
        AND ct.created_at >= p_day_start
    ), 0)
  INTO v_inviter_rewarded_today;

  SELECT
    COALESCE((
      SELECT SUM(ir.inviter_reward)
      FROM invitation_records AS ir
      WHERE ir.inviter_id = v_invitation_record.inviter_id
        AND ir.status = 'rewarded'
    ), 0) + COALESCE((
      SELECT SUM(ct.amount)
      FROM credit_transactions AS ct
      WHERE ct.user_id = v_invitation_record.inviter_id
        AND ct.type = 'addition'
        AND ct.amount > 0
        AND (
          ct.idempotency_key LIKE 'invitation_rebate:%'
          OR (
            ct.idempotency_key IS NULL
            AND ct.description LIKE '邀请消费返利（结算 %'
          )
        )
    ), 0)
  INTO v_inviter_rewarded_total;

  v_rebate_amount := v_raw_rebate_amount;

  IF COALESCE(p_daily_reward_limit, 0) > 0 THEN
    v_remaining_daily := GREATEST(0, p_daily_reward_limit - v_inviter_rewarded_today);
    v_rebate_amount := LEAST(v_rebate_amount, v_remaining_daily);
  END IF;

  IF COALESCE(p_total_reward_limit, 0) > 0 THEN
    v_remaining_total := GREATEST(0, p_total_reward_limit - v_inviter_rewarded_total);
    v_rebate_amount := LEAST(v_rebate_amount, v_remaining_total);
  END IF;

  IF v_rebate_amount <= 0 THEN
    RETURN QUERY SELECT
      'cap_exhausted'::TEXT,
      v_invitation_record.id,
      v_invitation_record.inviter_id,
      0,
      v_balance_before,
      v_balance_before,
      NULL::UUID,
      v_idempotency_key,
      FALSE;
    RETURN;
  END IF;

  v_balance_after := v_balance_before + v_rebate_amount;
  v_description := format(
    '邀请消费返利（source=invitation_rebate category=spend pre_deduct_id=%s）：%s 消费 %s 积分，返利 %s 积分',
    v_pre_deduct_id,
    COALESCE(NULLIF(v_invitation_record.invitee_email, ''), p_invitee_id::TEXT),
    p_consumed_credits,
    v_rebate_amount
  );

  UPDATE profiles AS p
  SET credits = v_balance_after
  WHERE p.id = v_invitation_record.inviter_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description,
    idempotency_key,
    balance_before,
    balance_after
  ) VALUES (
    v_invitation_record.inviter_id,
    v_rebate_amount,
    'addition',
    v_description,
    v_idempotency_key,
    v_balance_before,
    v_balance_after
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT
    'applied'::TEXT,
    v_invitation_record.id,
    v_invitation_record.inviter_id,
    v_rebate_amount,
    v_balance_before,
    v_balance_after,
    v_transaction_id,
    v_idempotency_key,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO service_role;

COMMENT ON FUNCTION atomic_apply_invitation_rebate(
  UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) IS 'Atomically applies invitation spend rebates by locking the inviter profile, enforcing caps, updating profile credits, inserting an addition credit transaction, and honoring invitation_rebate idempotency keys';
