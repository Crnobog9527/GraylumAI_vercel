-- Migration: atomic invitation claim
-- Description: Moves invitation claim rewards, records, and invitation status updates into one database transaction.

DO $$
DECLARE
  v_duplicate RECORD;
BEGIN
  SELECT ir.invite_code, ir.invitee_id, COUNT(*) AS duplicate_count
  INTO v_duplicate
  FROM invitation_records AS ir
  WHERE ir.invitee_id IS NOT NULL
  GROUP BY ir.invite_code, ir.invitee_id
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'duplicate invitation_records exist for invite_code %, invitee_id %',
      v_duplicate.invite_code,
      v_duplicate.invitee_id;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_records_invite_code_invitee_id
  ON invitation_records(invite_code, invitee_id);

CREATE OR REPLACE FUNCTION atomic_claim_invitation_code(
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
SET search_path = public
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

  IF p_claim_status NOT IN ('rewarded', 'rejected') THEN
    RAISE EXCEPTION 'invalid invitation claim status: %', p_claim_status;
  END IF;

  IF p_risk_level NOT IN ('low', 'medium', 'high') THEN
    RAISE EXCEPTION 'invalid invitation risk level: %', p_risk_level;
  END IF;

  IF COALESCE(p_inviter_reward, 0) < 0 OR COALESCE(p_invitee_reward, 0) < 0 THEN
    RAISE EXCEPTION 'invitation rewards must be non-negative';
  END IF;

  IF p_claim_status <> 'rewarded'
    AND (COALESCE(p_inviter_reward, 0) <> 0 OR COALESCE(p_invitee_reward, 0) <> 0) THEN
    RAISE EXCEPTION 'rejected invitation claims cannot grant rewards';
  END IF;

  SELECT i.code, i.created_by, i.status, i.used_by
  INTO v_invitation
  FROM invitations AS i
  WHERE i.code = v_invitation_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation code not found: %', v_invitation_code;
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

  IF v_invitation.created_by = p_invitee_id THEN
    RAISE EXCEPTION 'cannot claim own invitation code';
  END IF;

  FOR v_profile IN
    SELECT p.id, p.email, p.credits
    FROM profiles AS p
    WHERE p.id IN (v_invitation.created_by, p_invitee_id)
    ORDER BY p.id
    FOR UPDATE
  LOOP
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

  v_rewarded_at := CASE WHEN p_claim_status = 'rewarded' THEN NOW() ELSE NULL END;

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
    rewarded_at
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
    v_rewarded_at
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
