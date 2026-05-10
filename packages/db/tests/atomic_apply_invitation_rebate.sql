-- Smoke test for 0026_atomic_apply_invitation_rebate.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_no_binding_invitee_id UUID := gen_random_uuid();
  v_result RECORD;
  v_balance INTEGER;
  v_count INTEGER;
  v_transaction_type TEXT;
  v_transaction_description TEXT;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'rebate-rpc-inviter@example.test', 100),
    (v_invitee_id, 'rebate-rpc-invitee@example.test', 20),
    (v_no_binding_invitee_id, 'rebate-rpc-no-binding@example.test', 30);

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
    created_at,
    rewarded_at
  ) VALUES (
    'REBATEOK',
    v_inviter_id,
    'rebate-rpc-inviter@example.test',
    v_invitee_id,
    'rebate-rpc-invitee@example.test',
    'rewarded',
    'low',
    50,
    30,
    NOW() - INTERVAL '1 hour',
    NOW() - INTERVAL '1 hour'
  );

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_invitee_id,
    200,
    'smoke-pre-1',
    5,
    1000,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-pre-1'
  );

  IF v_result.status <> 'applied'
    OR v_result.rebate_amount <> 10
    OR v_result.balance_before <> 100
    OR v_result.balance_after <> 110
    OR v_result.is_idempotent IS NOT FALSE THEN
    RAISE EXCEPTION 'rebate application assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_inviter_id;
  IF v_balance <> 110 THEN
    RAISE EXCEPTION 'rebate balance assertion failed: %', v_balance;
  END IF;

  SELECT type, description
  INTO v_transaction_type, v_transaction_description
  FROM credit_transactions
  WHERE id = v_result.transaction_id;

  IF v_transaction_type <> 'addition' THEN
    RAISE EXCEPTION 'rebate transaction type assertion failed: %', v_transaction_type;
  END IF;

  IF v_transaction_description NOT LIKE '%source=invitation_rebate category=spend pre_deduct_id=smoke-pre-1%' THEN
    RAISE EXCEPTION 'rebate transaction description assertion failed: %', v_transaction_description;
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_invitee_id,
    999,
    'smoke-pre-1',
    50,
    1000,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-pre-1'
  );

  IF v_result.status <> 'already_applied'
    OR v_result.rebate_amount <> 10
    OR v_result.is_idempotent IS NOT TRUE THEN
    RAISE EXCEPTION 'rebate idempotency assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_inviter_id;
  IF v_balance <> 110 THEN
    RAISE EXCEPTION 'rebate replay changed balance: %', v_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE user_id = v_inviter_id
    AND idempotency_key = 'invitation_rebate:smoke-pre-1';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'rebate replay duplicated transaction: %', v_count;
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_no_binding_invitee_id,
    200,
    'smoke-no-binding',
    5,
    1000,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-no-binding'
  );

  IF v_result.status <> 'no_binding' OR v_result.rebate_amount <> 0 THEN
    RAISE EXCEPTION 'no binding assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key = 'invitation_rebate:smoke-no-binding';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'no binding wrote transaction: %', v_count;
  END IF;
END;
$$;

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_result RECORD;
  v_balance INTEGER;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'rebate-rpc-cap-inviter@example.test', 100),
    (v_invitee_id, 'rebate-rpc-cap-invitee@example.test', 20);

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
    created_at,
    rewarded_at
  ) VALUES (
    'REBATECAP',
    v_inviter_id,
    'rebate-rpc-cap-inviter@example.test',
    v_invitee_id,
    'rebate-rpc-cap-invitee@example.test',
    'rewarded',
    'low',
    95,
    30,
    NOW() - INTERVAL '1 hour',
    NOW() - INTERVAL '1 hour'
  );

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_invitee_id,
    200,
    'smoke-cap-partial',
    5,
    100,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-cap-partial'
  );

  IF v_result.status <> 'applied'
    OR v_result.rebate_amount <> 5
    OR v_result.balance_before <> 100
    OR v_result.balance_after <> 105 THEN
    RAISE EXCEPTION 'partial daily cap assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_inviter_id;
  IF v_balance <> 105 THEN
    RAISE EXCEPTION 'partial daily cap balance failed: %', v_balance;
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_invitee_id,
    200,
    'smoke-cap-exhausted',
    5,
    100,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-cap-exhausted'
  );

  IF v_result.status <> 'cap_exhausted'
    OR v_result.rebate_amount <> 0
    OR v_result.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'daily cap exhausted assertion failed: %', row_to_json(v_result);
  END IF;
END;
$$;

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_result RECORD;
  v_count INTEGER;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'rebate-rpc-description-inviter@example.test', 100),
    (v_invitee_id, 'rebate-rpc-description-invitee@example.test', 20);

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
    created_at,
    rewarded_at
  ) VALUES (
    'REBATEDESCRIPTION',
    v_inviter_id,
    'rebate-rpc-description-inviter@example.test',
    v_invitee_id,
    'rebate-rpc-description-invitee@example.test',
    'rewarded',
    'low',
    0,
    30,
    NOW() - INTERVAL '1 hour',
    NOW() - INTERVAL '1 hour'
  );

  INSERT INTO credit_transactions (user_id, amount, type, description)
  VALUES (
    v_inviter_id,
    10,
    'addition',
    '邀请消费返利（结算 smoke-description-only）：legacy description-only row'
  );

  SELECT *
  INTO v_result
  FROM atomic_apply_invitation_rebate(
    v_invitee_id,
    200,
    'smoke-description-only',
    5,
    1000,
    50000,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',
    'invitation_rebate:smoke-description-only'
  );

  IF v_result.status <> 'applied'
    OR v_result.rebate_amount <> 10
    OR v_result.is_idempotent IS NOT FALSE THEN
    RAISE EXCEPTION 'description-only duplicate assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE user_id = v_inviter_id
    AND (
      idempotency_key = 'invitation_rebate:smoke-description-only'
      OR description LIKE '%smoke-description-only%'
    );

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'description-only row blocked idempotent insert: %', v_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION test_fail_invitation_rebate_transaction_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'forced invitation rebate transaction failure';
END;
$$;

CREATE TRIGGER test_force_invitation_rebate_transaction_failure
BEFORE INSERT ON credit_transactions
FOR EACH ROW
WHEN (NEW.idempotency_key = 'invitation_rebate:smoke-fail')
EXECUTE FUNCTION test_fail_invitation_rebate_transaction_insert();

DO $$
DECLARE
  v_inviter_id UUID := gen_random_uuid();
  v_invitee_id UUID := gen_random_uuid();
  v_balance INTEGER;
  v_count INTEGER;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES
    (v_inviter_id, 'rebate-rpc-fail-inviter@example.test', 100),
    (v_invitee_id, 'rebate-rpc-fail-invitee@example.test', 20);

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
    created_at,
    rewarded_at
  ) VALUES (
    'REBATEFAIL',
    v_inviter_id,
    'rebate-rpc-fail-inviter@example.test',
    v_invitee_id,
    'rebate-rpc-fail-invitee@example.test',
    'rewarded',
    'low',
    0,
    30,
    NOW() - INTERVAL '1 hour',
    NOW() - INTERVAL '1 hour'
  );

  BEGIN
    PERFORM atomic_apply_invitation_rebate(
      v_invitee_id,
      200,
      'smoke-fail',
      5,
      1000,
      50000,
      NOW() - INTERVAL '30 days',
      NOW() - INTERVAL '1 day',
      'invitation_rebate:smoke-fail'
    );
    RAISE EXCEPTION 'forced rebate failure unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'forced invitation rebate transaction failure' THEN
        RAISE;
      END IF;
  END;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_inviter_id;
  IF v_balance <> 100 THEN
    RAISE EXCEPTION 'forced rebate failure changed balance: %', v_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM credit_transactions
  WHERE idempotency_key = 'invitation_rebate:smoke-fail';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'forced rebate failure wrote transaction: %', v_count;
  END IF;
END;
$$;

ROLLBACK;
