-- Migration: unified atomic credit ledger entry RPC
-- Description: Adds reusable balance snapshots and a single atomic profile credits + credit_transactions writer.

ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS balance_before INTEGER,
  ADD COLUMN IF NOT EXISTS balance_after INTEGER;

CREATE OR REPLACE FUNCTION atomic_apply_credit_ledger_entry(
  p_user_id UUID,
  p_amount INTEGER,
  p_type TEXT,
  p_description TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  transaction_id UUID,
  balance_before INTEGER,
  balance_after INTEGER,
  amount INTEGER,
  is_idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_transaction_id UUID;
  v_existing_transaction RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'amount must be non-zero';
  END IF;

  IF p_type IS NULL OR btrim(p_type) = '' THEN
    RAISE EXCEPTION 'transaction type is required';
  END IF;

  SELECT credits
  INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for user %', p_user_id;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT ct.id, ct.balance_before, ct.balance_after, ct.amount
    INTO v_existing_transaction
    FROM credit_transactions AS ct
    WHERE ct.user_id = p_user_id
      AND ct.idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT
        v_existing_transaction.id,
        v_existing_transaction.balance_before,
        v_existing_transaction.balance_after,
        v_existing_transaction.amount,
        TRUE;
      RETURN;
    END IF;
  END IF;

  v_balance_after := v_balance_before + p_amount;

  IF v_balance_after < 0 THEN
    RAISE EXCEPTION 'insufficient credits for user %: balance %, adjustment %',
      p_user_id,
      v_balance_before,
      p_amount;
  END IF;

  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description,
    idempotency_key,
    balance_before,
    balance_after
  ) VALUES (
    p_user_id,
    p_amount,
    p_type,
    p_description,
    p_idempotency_key,
    v_balance_before,
    v_balance_after
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT
    v_transaction_id,
    v_balance_before,
    v_balance_after,
    p_amount,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

COMMENT ON COLUMN credit_transactions.balance_before IS 'Profile credits balance before the ledger entry when written by atomic ledger RPCs';
COMMENT ON COLUMN credit_transactions.balance_after IS 'Profile credits balance after the ledger entry when written by atomic ledger RPCs';
COMMENT ON FUNCTION atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)
  IS 'Atomically applies one credit ledger entry by locking profiles, updating credits, inserting credit_transactions, and honoring per-user idempotency keys';
