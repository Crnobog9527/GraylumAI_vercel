-- Smoke test for 0024_atomic_apply_credit_ledger_entry.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_missing_user_id UUID := gen_random_uuid();
  v_result RECORD;
  v_balance INTEGER;
  v_transaction_count INTEGER;
BEGIN
  INSERT INTO profiles (id, email, credits)
  VALUES (v_user_id, 'ledger-rpc-smoke@example.test', 100);

  SELECT *
  INTO v_result
  FROM atomic_apply_credit_ledger_entry(
    v_user_id,
    25,
    'addition',
    'smoke positive grant',
    'smoke:add'
  );

  IF v_result.balance_before <> 100
    OR v_result.balance_after <> 125
    OR v_result.amount <> 25
    OR v_result.is_idempotent IS NOT FALSE THEN
    RAISE EXCEPTION 'positive grant assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_user_id;
  IF v_balance <> 125 THEN
    RAISE EXCEPTION 'positive grant balance assertion failed: %', v_balance;
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_apply_credit_ledger_entry(
    v_user_id,
    -40,
    'deduction',
    'smoke deduction',
    'smoke:deduct'
  );

  IF v_result.balance_before <> 125
    OR v_result.balance_after <> 85
    OR v_result.amount <> -40
    OR v_result.is_idempotent IS NOT FALSE THEN
    RAISE EXCEPTION 'deduction assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT *
  INTO v_result
  FROM atomic_apply_credit_ledger_entry(
    v_user_id,
    -40,
    'deduction',
    'smoke deduction replay',
    'smoke:deduct'
  );

  IF v_result.balance_before <> 125
    OR v_result.balance_after <> 85
    OR v_result.amount <> -40
    OR v_result.is_idempotent IS NOT TRUE THEN
    RAISE EXCEPTION 'idempotency replay assertion failed: %', row_to_json(v_result);
  END IF;

  SELECT COUNT(*)
  INTO v_transaction_count
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'smoke:deduct';

  IF v_transaction_count <> 1 THEN
    RAISE EXCEPTION 'idempotency transaction count assertion failed: %', v_transaction_count;
  END IF;

  BEGIN
    PERFORM atomic_apply_credit_ledger_entry(
      v_user_id,
      -1000,
      'deduction',
      'smoke insufficient',
      'smoke:insufficient'
    );
    RAISE EXCEPTION 'insufficient balance call unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'insufficient credits for user%' THEN
        RAISE;
      END IF;
  END;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_user_id;
  IF v_balance <> 85 THEN
    RAISE EXCEPTION 'insufficient balance changed credits: %', v_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_transaction_count
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'smoke:insufficient';

  IF v_transaction_count <> 0 THEN
    RAISE EXCEPTION 'insufficient balance wrote transaction: %', v_transaction_count;
  END IF;

  BEGIN
    PERFORM atomic_apply_credit_ledger_entry(
      v_user_id,
      0,
      'addition',
      'smoke zero amount',
      'smoke:zero'
    );
    RAISE EXCEPTION 'zero amount call unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'amount must be non-zero' THEN
        RAISE;
      END IF;
  END;

  SELECT credits INTO v_balance FROM profiles WHERE id = v_user_id;
  IF v_balance <> 85 THEN
    RAISE EXCEPTION 'zero amount changed credits: %', v_balance;
  END IF;

  SELECT COUNT(*)
  INTO v_transaction_count
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'smoke:zero';

  IF v_transaction_count <> 0 THEN
    RAISE EXCEPTION 'zero amount wrote transaction: %', v_transaction_count;
  END IF;

  BEGIN
    PERFORM atomic_apply_credit_ledger_entry(
      v_missing_user_id,
      1,
      'addition',
      'smoke missing user',
      'smoke:missing-user'
    );
    RAISE EXCEPTION 'missing user call unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'profile not found for user%' THEN
        RAISE;
      END IF;
  END;
END;
$$;

ROLLBACK;
