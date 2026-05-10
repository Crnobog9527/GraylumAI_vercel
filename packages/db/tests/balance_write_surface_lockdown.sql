-- Smoke test for 0027_balance_write_surface_lockdown.sql.
-- Run against a migrated Supabase database with psql; the transaction rolls back all test data.

BEGIN;

SELECT set_config('balance_lockdown.user_id', gen_random_uuid()::TEXT, true);
SELECT set_config('balance_lockdown.other_user_id', gen_random_uuid()::TEXT, true);

INSERT INTO profiles (id, email, nickname, credits)
VALUES (
  current_setting('balance_lockdown.other_user_id')::UUID,
  'balance-lockdown-other@example.test',
  'other',
  100
);

DO $$
DECLARE
  v_function TEXT;
  v_service_only_functions TEXT[] := ARRAY[
    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
    'public.atomic_claim_invitation_code(text,uuid,text,text,text,text,integer,integer,text,text)',
    'public.atomic_apply_invitation_rebate(uuid,integer,text,integer,integer,integer,timestamp with time zone,timestamp with time zone,text)',
    'public.atomic_fulfill_credit_package(text,text)',
    'public.atomic_fulfill_membership_invoice(text,text,integer,text,text,text,timestamp with time zone,timestamp with time zone)'
  ];
BEGIN
  IF has_column_privilege('anon', 'public.profiles', 'credits', 'UPDATE') THEN
    RAISE EXCEPTION 'anon can update profiles.credits';
  END IF;

  IF has_column_privilege('authenticated', 'public.profiles', 'credits', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update profiles.credits';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.profiles', 'nickname', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated cannot update profiles.nickname';
  END IF;

  IF has_table_privilege('authenticated', 'public.credit_transactions', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated can insert credit_transactions';
  END IF;

  IF has_table_privilege('authenticated', 'public.billing_history', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated can insert billing_history';
  END IF;

  IF has_table_privilege('authenticated', 'public.token_stats', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated can insert token_stats';
  END IF;

  IF has_table_privilege('authenticated', 'public.payment_orders', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update payment_orders';
  END IF;

  IF has_table_privilege('authenticated', 'public.user_subscriptions', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update user_subscriptions';
  END IF;

  FOREACH v_function IN ARRAY v_service_only_functions LOOP
    IF has_function_privilege('anon', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute service-only function: %', v_function;
    END IF;

    IF has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can execute service-only function: %', v_function;
    END IF;

    IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute service-only function: %', v_function;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute claim_daily_checkin';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute claim_daily_checkin';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute claim_daily_checkin';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('balance_lockdown.user_id'), true);

DO $$
BEGIN
  BEGIN
    INSERT INTO profiles (id, email, nickname, role, credits)
    VALUES (
      current_setting('balance_lockdown.user_id')::UUID,
      'balance-lockdown-user@example.test',
      'forbidden-non-zero',
      'user',
      100
    );
    RAISE EXCEPTION 'authenticated non-zero profile insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

INSERT INTO profiles (id, email, nickname, role, credits)
VALUES (
  current_setting('balance_lockdown.user_id')::UUID,
  'balance-lockdown-user@example.test',
  'before',
  'user',
  0
);

UPDATE profiles
SET
  email = 'balance-lockdown-user-updated@example.test',
  nickname = 'after',
  avatar_url = 'https://example.test/avatar.png'
WHERE id = current_setting('balance_lockdown.user_id')::UUID;

DO $$
BEGIN
  BEGIN
    UPDATE profiles
    SET credits = credits + 1
    WHERE id = current_setting('balance_lockdown.user_id')::UUID;
    RAISE EXCEPTION 'authenticated credits update unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    INSERT INTO credit_transactions (user_id, amount, type, description)
    VALUES (
      current_setting('balance_lockdown.user_id')::UUID,
      1,
      'addition',
      'forbidden direct ledger insert'
    );
    RAISE EXCEPTION 'authenticated credit_transactions insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    INSERT INTO billing_history (user_id, operation_type, amount, reason)
    VALUES (
      current_setting('balance_lockdown.user_id')::UUID,
      'refund',
      1,
      'forbidden direct billing insert'
    );
    RAISE EXCEPTION 'authenticated billing_history insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    PERFORM atomic_apply_credit_ledger_entry(
      current_setting('balance_lockdown.user_id')::UUID,
      1,
      'addition',
      'forbidden direct rpc',
      'balance-lockdown:forbidden'
    );
    RAISE EXCEPTION 'authenticated service-only RPC execution unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_result RECORD;
BEGIN
  SELECT *
  INTO v_result
  FROM atomic_apply_credit_ledger_entry(
    current_setting('balance_lockdown.user_id')::UUID,
    10,
    'addition',
    'service_role smoke grant',
    'balance-lockdown:service-grant'
  );

  IF v_result.balance_before <> 0 OR v_result.balance_after <> 10 THEN
    RAISE EXCEPTION 'service_role ledger RPC assertion failed: %', row_to_json(v_result);
  END IF;
END;
$$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('balance_lockdown.user_id'), true);

DO $$
DECLARE
  v_checkin RECORD;
BEGIN
  SELECT *
  INTO v_checkin
  FROM claim_daily_checkin(current_setting('balance_lockdown.user_id')::UUID);

  IF v_checkin.already_claimed IS NOT FALSE OR v_checkin.total_reward_credits <= 0 THEN
    RAISE EXCEPTION 'own checkin assertion failed: %', row_to_json(v_checkin);
  END IF;

  BEGIN
    PERFORM claim_daily_checkin(current_setting('balance_lockdown.other_user_id')::UUID);
    RAISE EXCEPTION 'cross-user checkin unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'claim_daily_checkin user mismatch' THEN
        RAISE;
      END IF;
  END;
END;
$$;

ROLLBACK;
