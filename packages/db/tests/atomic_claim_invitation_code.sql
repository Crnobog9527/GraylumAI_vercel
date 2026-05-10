-- Smoke test for 0025_atomic_claim_invitation_code.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_other_invitee_id UUID := gen_random_uuid();
  v_self_code TEXT := 'SMOKESELF';
  v_result RECORD;
  v_inviter_balance INTEGER;
  v_invitee_balance INTEGER;
  v_count INTEGER;
  v_invitation_status TEXT;
  v_invitation_used_by UUID;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'invite-rpc-inviter@example.test', 100),
    (v_invitee_id, 'invite-rpc-invitee@example.test', 20),
    (v_other_invitee_id, 'invite-rpc-other@example.test', 5);

  INSERT INTO invitations (code, created_by, status)
  VALUES ('SMOKEOK', v_inviter_id, 'active');

  SELECT *
  INTO v_result
  FROM atomic_claim_invitation_code(
    'SMOKEOK',
    v_invitee_id,
    'invite-rpc-invitee@example.test',
    'rewarded',
    'low',
    NULL,
    50,
    30,
    '203.0.113.1',
    'smoke-agent'
  );

  IF v_result.status <> 'rewarded'
    OR v_result.inviter_reward <> 50
    OR v_result.invitee_reward <> 30
    OR v_result.is_idempotent IS NOT FALSE THEN
    RAISE EXCEPTION 'claim result assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_inviter_balance FROM profiles WHERE id = v_inviter_id;
  SELECT credits INTO v_invitee_balance FROM profiles WHERE id = v_invitee_id;

  IF v_inviter_balance <> 150 OR v_invitee_balance <> 50 THEN
    RAISE EXCEPTION 'claim balance assertion failed: inviter %, invitee %',
      v_inviter_balance,
      v_invitee_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM invitation_records
  WHERE invite_code = 'SMOKEOK'
    AND invitee_id = v_invitee_id
    AND status = 'rewarded'
    AND inviter_reward = 50
    AND invitee_reward = 30;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'invitation record assertion failed: %', v_count;
  END IF;

  SELECT status, used_by
  INTO v_invitation_status, v_invitation_used_by
  FROM invitations
  WHERE code = 'SMOKEOK';

  IF v_invitation_status <> 'used' OR v_invitation_used_by <> v_invitee_id THEN
    RAISE EXCEPTION 'invitation status assertion failed: %, %',
      v_invitation_status,
      v_invitation_used_by;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE user_id IN (v_inviter_id, v_invitee_id)
    AND type = 'addition'
    AND idempotency_key IN (
      'invitation_claim:invitee:SMOKEOK:' || v_invitee_id::TEXT,
      'invitation_claim:inviter:SMOKEOK:' || v_inviter_id::TEXT || ':' || v_invitee_id::TEXT
    );

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'credit transaction type/idempotency assertion failed: %', v_count;
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_claim_invitation_code(
    'SMOKEOK',
    v_invitee_id,
    'invite-rpc-invitee@example.test',
    'rewarded',
    'low',
    NULL,
    50,
    30,
    '203.0.113.1',
    'smoke-agent'
  );

  IF v_result.is_idempotent IS NOT TRUE THEN
    RAISE EXCEPTION 'claim replay was not idempotent: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_inviter_balance FROM profiles WHERE id = v_inviter_id;
  SELECT credits INTO v_invitee_balance FROM profiles WHERE id = v_invitee_id;

  IF v_inviter_balance <> 150 OR v_invitee_balance <> 50 THEN
    RAISE EXCEPTION 'claim replay changed balances: inviter %, invitee %',
      v_inviter_balance,
      v_invitee_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKEOK:%';

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'claim replay duplicated transactions: %', v_count;
  END IF;

  INSERT INTO invitations (code, created_by, status)
  VALUES ('SMOKEACTIVEFIX', v_inviter_id, 'active');

  INSERT INTO invitation_records (
    invite_code,
    inviter_id,
    inviter_email,
    invitee_id,
    invitee_email,
    status,
    risk_level,
    inviter_reward,
    invitee_reward,
    rewarded_at
  ) VALUES (
    'SMOKEACTIVEFIX',
    v_inviter_id,
    'invite-rpc-inviter@example.test',
    v_other_invitee_id,
    'invite-rpc-other@example.test',
    'rewarded',
    'low',
    40,
    20,
    NOW()
  );

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES
    (
      v_other_invitee_id,
      20,
      'addition',
      'existing invitee reward',
      'invitation_claim:invitee:SMOKEACTIVEFIX:' || v_other_invitee_id::TEXT
    ),
    (
      v_inviter_id,
      40,
      'addition',
      'existing inviter reward',
      'invitation_claim:inviter:SMOKEACTIVEFIX:' || v_inviter_id::TEXT || ':' || v_other_invitee_id::TEXT
    );

  SELECT *
  INTO v_result
  FROM atomic_claim_invitation_code(
    'SMOKEACTIVEFIX',
    v_other_invitee_id,
    'invite-rpc-other@example.test',
    'rewarded',
    'low',
    NULL,
    40,
    20,
    NULL,
    NULL
  );

  IF v_result.is_idempotent IS NOT TRUE THEN
    RAISE EXCEPTION 'active repair replay was not idempotent: %', row_to_json(v_result);
  END IF;

  SELECT status, used_by
  INTO v_invitation_status, v_invitation_used_by
  FROM invitations
  WHERE code = 'SMOKEACTIVEFIX';

  IF v_invitation_status <> 'used' OR v_invitation_used_by <> v_other_invitee_id THEN
    RAISE EXCEPTION 'active repair did not mark invitation used: %, %',
      v_invitation_status,
      v_invitation_used_by;
  END IF;

  SELECT credits INTO v_inviter_balance FROM profiles WHERE id = v_inviter_id;
  SELECT credits INTO v_invitee_balance FROM profiles WHERE id = v_other_invitee_id;

  IF v_inviter_balance <> 150 OR v_invitee_balance <> 5 THEN
    RAISE EXCEPTION 'active repair changed balances: inviter %, invitee %',
      v_inviter_balance,
      v_invitee_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKEACTIVEFIX:%';

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'active repair duplicated transactions: %', v_count;
  END IF;

  INSERT INTO invitations (code, created_by, status)
  VALUES (v_self_code, v_invitee_id, 'active');

  BEGIN
    PERFORM atomic_claim_invitation_code(
      v_self_code,
      v_invitee_id,
      'invite-rpc-invitee@example.test',
      'rewarded',
      'low',
      NULL,
      50,
      30,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'self invite unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'cannot claim own invitation code' THEN
        RAISE;
      END IF;
  END;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKESELF:%';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'self invite wrote transactions: %', v_count;
  END IF;

  INSERT INTO invitations (code, created_by, status, used_by)
  VALUES ('SMOKEUSED', v_inviter_id, 'used', v_other_invitee_id);

  BEGIN
    PERFORM atomic_claim_invitation_code(
      'SMOKEUSED',
      v_invitee_id,
      'invite-rpc-invitee@example.test',
      'rewarded',
      'low',
      NULL,
      50,
      30,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'used invitation unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'invitation code is not active%' THEN
        RAISE;
      END IF;
  END;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKEUSED:%';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'used invitation wrote transactions: %', v_count;
  END IF;

  BEGIN
    PERFORM atomic_claim_invitation_code(
      'SMOKEMISSING',
      v_invitee_id,
      'invite-rpc-invitee@example.test',
      'rewarded',
      'low',
      NULL,
      50,
      30,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'missing invitation unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'invitation code not found%' THEN
        RAISE;
      END IF;
  END;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKEMISSING:%';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'missing invitation wrote transactions: %', v_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION test_fail_invitation_record_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'forced invitation record failure';
END;
$$;

CREATE TRIGGER test_force_invitation_record_failure
BEFORE INSERT ON invitation_records
FOR EACH ROW
WHEN (NEW.invite_code = 'SMOKEFAIL')
EXECUTE FUNCTION test_fail_invitation_record_insert();

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_inviter_balance INTEGER;
  v_invitee_balance INTEGER;
  v_count INTEGER;
  v_invitation_status TEXT;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'invite-rpc-fail-inviter@example.test', 100),
    (v_invitee_id, 'invite-rpc-fail-invitee@example.test', 20);

  INSERT INTO invitations (code, created_by, status)
  VALUES ('SMOKEFAIL', v_inviter_id, 'active');

  BEGIN
    PERFORM atomic_claim_invitation_code(
      'SMOKEFAIL',
      v_invitee_id,
      'invite-rpc-fail-invitee@example.test',
      'rewarded',
      'low',
      NULL,
      50,
      30,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'forced failure claim unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'forced invitation record failure' THEN
        RAISE;
      END IF;
  END;

  SELECT credits INTO v_inviter_balance FROM profiles WHERE id = v_inviter_id;
  SELECT credits INTO v_invitee_balance FROM profiles WHERE id = v_invitee_id;
  SELECT status INTO v_invitation_status FROM invitations WHERE code = 'SMOKEFAIL';

  IF v_inviter_balance <> 100 OR v_invitee_balance <> 20 OR v_invitation_status <> 'active' THEN
    RAISE EXCEPTION 'forced failure left partial state: inviter %, invitee %, status %',
      v_inviter_balance,
      v_invitee_balance,
      v_invitation_status;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key LIKE 'invitation_claim:%:SMOKEFAIL:%';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'forced failure wrote transactions: %', v_count;
  END IF;
END;
$$;

ROLLBACK;
