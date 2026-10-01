-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- INVITE-ABUSE: reuse the exact opening-grant ledger decision, never extend identity retention.
-- 0153 belongs to ENTITLEMENTS; recheck numbering against staging before delivery.
BEGIN;
CREATE INDEX IF NOT EXISTS invitation_records_invitee_decision_idx
  ON public.invitation_records(invitee_id) WHERE status IN ('rewarded', 'rejected');

CREATE OR REPLACE FUNCTION public.atomic_claim_invitation_code(
  p_invitation_code TEXT,
  p_invitee_id UUID,
  p_invitee_email TEXT,
  p_claim_status TEXT,
  p_risk_level TEXT,
  p_block_reason TEXT DEFAULT NULL,
  p_inviter_reward INTEGER DEFAULT 0,
  p_invitee_reward INTEGER DEFAULT 0,
  p_ip_address TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE (
  invitation_record_id UUID,
  invitation_code TEXT,
  inviter_id UUID,
  invitee_id UUID,
  status TEXT,
  risk_level TEXT,
  block_reason TEXT,
  inviter_reward INTEGER,
  invitee_reward INTEGER,
  inviter_transaction_id UUID,
  invitee_transaction_id UUID,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation_code TEXT := btrim(p_invitation_code);
  v_invitation RECORD;
  v_existing_record RECORD;
  v_profile RECORD;
  v_inviter_id UUID;
  v_inviter_email TEXT;
  v_invitee_profile_found BOOLEAN := FALSE;
  v_inviter_ledger RECORD;
  v_invitee_ledger RECORD;
  v_inviter_transaction_id UUID;
  v_invitee_transaction_id UUID;
  v_inviter_idempotency_key TEXT;
  v_invitee_idempotency_key TEXT;
  v_inviter_description TEXT;
  v_invitee_description TEXT;
  v_invitation_record_id UUID;
  v_rewarded_at TIMESTAMPTZ;
  v_opening_amount integer;
  v_now timestamptz;
  v_day timestamptz;
  v_month timestamptz;
  v_daily numeric;
  v_total numeric;
  v_month_count bigint;
  v_ip_hour bigint;
  v_ip_day bigint;
  v_auto_reject boolean := true;
  v_raw jsonb;
  v_number numeric;
  v_setting record;
  v_config jsonb := '{"invite_inviter_reward":50,"invite_invitee_reward":30,
    "invite_daily_reward_limit":1000,"invite_total_reward_limit":50000,"invite_monthly_count_limit":50,
    "invite_same_ip_hour_limit":3,"invite_same_ip_day_limit":5}';
  v_settings jsonb;
BEGIN
  IF v_invitation_code IS NULL OR v_invitation_code = '' THEN
    RAISE EXCEPTION 'invitation code is required';
  END IF;

  IF p_invitee_id IS NULL THEN
    RAISE EXCEPTION 'invitee_id is required';
  END IF;

  IF p_invitee_email IS NULL OR btrim(p_invitee_email) = '' THEN
    RAISE EXCEPTION 'invitee_email is required';
  END IF;

  -- Retain the old signature for deploy compatibility, but never trust caller reward/risk decisions.
  -- New callers send server_decides, which the pre-migration function rejects (no unsafe fallback).
  SELECT i.code, i.created_by, i.status, i.used_by
  INTO v_invitation
  FROM invitations AS i
  WHERE i.code = v_invitation_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation code not found: %', v_invitation_code;
  END IF;

  IF v_invitation.created_by = p_invitee_id THEN
    RAISE EXCEPTION 'cannot claim own invitation code';
  END IF;

  FOR v_profile IN
    SELECT p.id, p.email, p.credits, p.status, p.is_deleted
    FROM profiles AS p
    WHERE p.id IN (v_invitation.created_by, p_invitee_id)
    ORDER BY p.id
    FOR UPDATE
  LOOP
    IF v_profile.status IS DISTINCT FROM 'active' OR v_profile.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = v_profile.id) THEN
      RAISE EXCEPTION 'ACCOUNT_CLOSED' USING ERRCODE = '42501';
    END IF;
    IF v_profile.id = v_invitation.created_by THEN
      v_inviter_id := v_profile.id;
      v_inviter_email := v_profile.email;
    ELSIF v_profile.id = p_invitee_id THEN
      v_invitee_profile_found := TRUE;
    END IF;
  END LOOP;

  IF v_inviter_id IS NULL THEN
    RAISE EXCEPTION 'inviter profile not found: %', v_invitation.created_by;
  END IF;

  IF NOT v_invitee_profile_found THEN
    RAISE EXCEPTION 'invitee profile not found: %', p_invitee_id;
  END IF;

  SELECT ir.*
  INTO v_existing_record
  FROM invitation_records AS ir
  WHERE ir.invite_code = v_invitation_code
    AND ir.invitee_id = p_invitee_id
  LIMIT 1;

  IF FOUND THEN
    v_inviter_idempotency_key := format(
      'invitation_claim:inviter:%s:%s:%s',
      v_invitation_code,
      v_existing_record.inviter_id,
      p_invitee_id
    );
    v_invitee_idempotency_key := format(
      'invitation_claim:invitee:%s:%s',
      v_invitation_code,
      p_invitee_id
    );

    IF COALESCE(v_existing_record.inviter_reward, 0) > 0 THEN
      SELECT ct.id
      INTO v_inviter_transaction_id
      FROM credit_transactions AS ct
      WHERE ct.user_id = v_existing_record.inviter_id
        AND ct.idempotency_key = v_inviter_idempotency_key
      LIMIT 1;
    END IF;

    IF COALESCE(v_existing_record.invitee_reward, 0) > 0 THEN
      SELECT ct.id
      INTO v_invitee_transaction_id
      FROM credit_transactions AS ct
      WHERE ct.user_id = p_invitee_id
        AND ct.idempotency_key = v_invitee_idempotency_key
      LIMIT 1;
    END IF;

    IF v_invitation.status = 'active' THEN
      UPDATE invitations AS i
      SET
        status = 'used',
        used_by = v_existing_record.invitee_id
      WHERE i.code = v_invitation_code;
    END IF;

    RETURN QUERY SELECT
      v_existing_record.id,
      v_existing_record.invite_code,
      v_existing_record.inviter_id,
      v_existing_record.invitee_id,
      v_existing_record.status,
      v_existing_record.risk_level,
      v_existing_record.block_reason,
      v_existing_record.inviter_reward,
      v_existing_record.invitee_reward,
      v_inviter_transaction_id,
      v_invitee_transaction_id,
      TRUE;
    RETURN;
  END IF;

  IF v_invitation.status <> 'active' OR v_invitation.used_by IS NOT NULL THEN
    RAISE EXCEPTION 'invitation code is not active: %', v_invitation_code;
  END IF;

  -- The invitee profile lock serializes different codes and all eligibility checks.
  IF EXISTS (SELECT 1 FROM public.invitation_records ir WHERE ir.invitee_id = p_invitee_id
    AND ir.status IN ('rewarded', 'rejected')) THEN
    RETURN QUERY SELECT NULL::uuid, v_invitation_code, v_inviter_id, p_invitee_id,
      'rejected'::text, 'low'::text, 'invitation_already_decided'::text, 0, 0,
      NULL::uuid, NULL::uuid, false;
    RETURN;
  END IF;
  SELECT ct.amount INTO v_opening_amount FROM public.credit_transactions ct
    WHERE ct.user_id = p_invitee_id AND ct.idempotency_key = 'opening_grant:' || p_invitee_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITATION_OPENING_DECISION_MISSING' USING ERRCODE = '55000';
  END IF;

  p_ip_address := NULLIF(btrim(p_ip_address), '');
  IF p_ip_address IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('invitation_claim_ip:' || p_ip_address, 0));
  END IF;
  -- Time and statistics are read AFTER locks, including when waiting across a day/month boundary.
  v_now := clock_timestamp();
  v_day := date_trunc('day', v_now AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_month := date_trunc('month', v_now AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  SELECT coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) INTO v_settings
    FROM public.system_settings s WHERE s.key IN (SELECT jsonb_object_keys(v_config))
      OR s.key = 'invite_risk_auto_reject';
  -- Match the existing JS integer parser: numeric truncation, string decimal-prefix parse, >=0.
  -- Configuration outside the monetary integer domain fails closed, never truncates/wraps.
  FOR v_setting IN SELECT key, value FROM jsonb_each(v_config) LOOP
    v_raw := v_settings -> v_setting.key;
    v_number := NULL;
    IF jsonb_typeof(v_raw) = 'number' THEN
      v_number := trunc((v_raw #>> '{}')::numeric);
    ELSIF jsonb_typeof(v_raw) = 'string' THEN
      v_number := substring(ltrim(v_raw #>> '{}') from '^[+-]?[0-9]+')::numeric;
    END IF;
    IF v_number IS NOT NULL THEN
      v_number := greatest(0, v_number);
      IF v_number > 2147483647 THEN RAISE EXCEPTION 'INVITATION_SETTING_OUT_OF_RANGE'; END IF;
      v_config := jsonb_set(v_config, ARRAY[v_setting.key], to_jsonb(v_number::integer));
    END IF;
  END LOOP;
  IF v_settings->'invite_risk_auto_reject' IN ('false'::jsonb, '"false"'::jsonb) THEN
    v_auto_reject := false;
  END IF;
  SELECT count(*) FILTER (WHERE ir.created_at >= v_month),
    coalesce(sum(ir.inviter_reward) FILTER (WHERE ir.created_at >= v_day),0),
    coalesce(sum(ir.inviter_reward),0)
    INTO v_month_count, v_daily, v_total
    FROM public.invitation_records ir WHERE ir.inviter_id = v_inviter_id AND ir.status = 'rewarded';
  -- Existing spend rebates share the cap; do not count the claim ledger as well as its record.
  SELECT v_daily + coalesce(sum(ct.amount) FILTER (WHERE ct.created_at >= v_day),0),
    v_total + coalesce(sum(ct.amount),0) INTO v_daily, v_total
    FROM public.credit_transactions ct WHERE ct.user_id = v_inviter_id AND ct.type = 'addition'
      AND ct.amount > 0 AND (ct.idempotency_key LIKE 'invitation_rebate:%'
        OR (ct.idempotency_key IS NULL AND ct.description LIKE '邀请消费返利（结算 %'));
  SELECT count(*) FILTER (WHERE ir.created_at >= v_now - interval '1 hour'),
    count(*) FILTER (WHERE ir.created_at >= v_day)
    INTO v_ip_hour, v_ip_day FROM public.invitation_records ir
    WHERE ir.ip_address = p_ip_address AND ir.created_at >= least(v_day, v_now - interval '1 hour');
  p_claim_status := 'rewarded'; p_risk_level := 'low'; p_block_reason := NULL;
  p_inviter_reward := (v_config->>'invite_inviter_reward')::integer;
  p_invitee_reward := (v_config->>'invite_invitee_reward')::integer;
  IF p_ip_address IS NOT NULL AND (
    ((v_config->>'invite_same_ip_hour_limit')::integer > 0
      AND v_ip_hour >= (v_config->>'invite_same_ip_hour_limit')::integer)
    OR ((v_config->>'invite_same_ip_day_limit')::integer > 0
      AND v_ip_day >= (v_config->>'invite_same_ip_day_limit')::integer)) THEN
    p_risk_level := 'high';
    IF v_auto_reject THEN
      p_claim_status := 'rejected'; p_block_reason := 'invitation_ip_limit';
    END IF;
  END IF;
  IF p_claim_status <> 'rejected' AND (v_config->>'invite_monthly_count_limit')::integer > 0
    AND v_month_count >= (v_config->>'invite_monthly_count_limit')::integer THEN
    p_claim_status := 'rejected'; p_risk_level := 'medium'; p_block_reason := 'invitation_monthly_limit';
  END IF;
  IF v_opening_amount <= 0 THEN
    p_claim_status := 'rejected'; p_block_reason := 'invitation_opening_ineligible';
  END IF;
  IF p_claim_status = 'rejected' THEN
    p_inviter_reward := 0; p_invitee_reward := 0;
  ELSE
    IF (v_config->>'invite_daily_reward_limit')::integer > 0 THEN
      p_inviter_reward := least(p_inviter_reward, greatest(0,(v_config->>'invite_daily_reward_limit')::numeric-v_daily));
    END IF;
    IF (v_config->>'invite_total_reward_limit')::integer > 0 THEN
      p_inviter_reward := least(p_inviter_reward, greatest(0,(v_config->>'invite_total_reward_limit')::numeric-v_total));
    END IF;
  END IF;

  v_inviter_idempotency_key := format(
    'invitation_claim:inviter:%s:%s:%s',
    v_invitation_code,
    v_inviter_id,
    p_invitee_id
  );
  v_invitee_idempotency_key := format(
    'invitation_claim:invitee:%s:%s',
    v_invitation_code,
    p_invitee_id
  );
  v_inviter_description := format('邀请奖励：%s 注册成功', p_invitee_email);
  v_invitee_description := format('邀请码奖励：使用 %s 完成注册', v_invitation_code);

  IF COALESCE(p_invitee_reward, 0) > 0 THEN
    SELECT *
    INTO v_invitee_ledger
    FROM atomic_apply_credit_ledger_entry(
      p_invitee_id,
      p_invitee_reward,
      'addition',
      v_invitee_description,
      v_invitee_idempotency_key
    );
    v_invitee_transaction_id := v_invitee_ledger.transaction_id;
  END IF;

  IF COALESCE(p_inviter_reward, 0) > 0 THEN
    SELECT *
    INTO v_inviter_ledger
    FROM atomic_apply_credit_ledger_entry(
      v_inviter_id,
      p_inviter_reward,
      'addition',
      v_inviter_description,
      v_inviter_idempotency_key
    );
    v_inviter_transaction_id := v_inviter_ledger.transaction_id;
  END IF;

  v_rewarded_at := CASE WHEN p_claim_status = 'rewarded' THEN v_now ELSE NULL END;

  INSERT INTO invitation_records (
    invite_code,
    inviter_id,
    inviter_email,
    invitee_id,
    invitee_email,
    status,
    risk_level,
    block_reason,
    inviter_reward,
    invitee_reward,
    ip_address,
    user_agent,
    rewarded_at,
    created_at
  ) VALUES (
    v_invitation_code,
    v_inviter_id,
    v_inviter_email,
    p_invitee_id,
    p_invitee_email,
    p_claim_status,
    p_risk_level,
    p_block_reason,
    COALESCE(p_inviter_reward, 0),
    COALESCE(p_invitee_reward, 0),
    p_ip_address,
    p_user_agent,
    v_rewarded_at,
    v_now
  )
  RETURNING id INTO v_invitation_record_id;

  UPDATE invitations AS i
  SET
    status = 'used',
    used_by = p_invitee_id
  WHERE i.code = v_invitation_code;

  RETURN QUERY SELECT
    v_invitation_record_id,
    v_invitation_code,
    v_inviter_id,
    p_invitee_id,
    p_claim_status,
    p_risk_level,
    p_block_reason,
    COALESCE(p_inviter_reward, 0),
    COALESCE(p_invitee_reward, 0),
    v_inviter_transaction_id,
    v_invitee_transaction_id,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION atomic_claim_invitation_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) IS 'Atomically claims one invitation code by locking the invitation and profiles, applying invitation reward ledger entries, inserting invitation_records, and marking the invitation used';

CREATE OR REPLACE FUNCTION public.atomic_apply_invitation_rebate(
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
SET search_path = public, pg_temp
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
    IF v_existing_transaction.balance_before NOT BETWEEN -2147483648::bigint AND 2147483647::bigint
      OR v_existing_transaction.balance_after NOT BETWEEN -2147483648::bigint AND 2147483647::bigint THEN
      RAISE EXCEPTION 'INVITATION_REBATE_BALANCE_OUT_OF_RANGE' USING ERRCODE = '22003';
    END IF;
    RETURN QUERY SELECT
      'already_applied'::TEXT,
      v_invitation_record.id,
      v_invitation_record.inviter_id,
      COALESCE(v_existing_transaction.amount, 0),
      v_existing_transaction.balance_before::integer,
      v_existing_transaction.balance_after::integer,
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

COMMIT;
