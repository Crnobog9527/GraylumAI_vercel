/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Smoke test for 0046_profile_bootstrap_service_role_grants.sql.
-- Run against an owner-approved migrated staging database with psql; the
-- transaction rolls back all test data. Do not run against production.

BEGIN;

SELECT set_config('profile_bootstrap.user_id', gen_random_uuid()::TEXT, true);
SELECT set_config('profile_bootstrap.other_user_id', gen_random_uuid()::TEXT, true);

DO $$
DECLARE
  v_column TEXT;
  v_bootstrap_columns TEXT[] := ARRAY[
    'id',
    'email',
    'nickname',
    'role',
    'status',
    'membership_level',
    'credits'
  ];
BEGIN
  IF NOT has_table_privilege('service_role', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'service_role cannot select profiles';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'service_role cannot delete profiles for bootstrap cleanup';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.credit_transactions', 'SELECT') THEN
    RAISE EXCEPTION 'service_role cannot select credit_transactions for cleanup safety checks';
  END IF;

  FOREACH v_column IN ARRAY v_bootstrap_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.profiles', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'service_role cannot insert profiles.%', v_column;
    END IF;

    IF has_column_privilege('anon', 'public.profiles', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'anon can insert profiles.%', v_column;
    END IF;

    IF has_column_privilege('authenticated', 'public.profiles', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'authenticated can insert profiles.%', v_column;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'anon has table-level profiles INSERT';
  END IF;

  IF has_table_privilege('authenticated', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated has table-level profiles INSERT';
  END IF;

  IF has_table_privilege('anon', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'anon has profiles DELETE';
  END IF;

  IF has_table_privilege('authenticated', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated has profiles DELETE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'profiles_insert_own_zero_credits'
  ) THEN
    RAISE EXCEPTION 'legacy authenticated profile insert policy is still present';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon can execute atomic_apply_credit_ledger_entry';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can execute atomic_apply_credit_ledger_entry';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role cannot execute atomic_apply_credit_ledger_entry';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

SELECT 1
FROM public.credit_transactions
WHERE user_id = current_setting('profile_bootstrap.user_id')::UUID
  AND idempotency_key = 'opening_grant:' || current_setting('profile_bootstrap.user_id')
LIMIT 1;

INSERT INTO public.profiles (
  id,
  email,
  nickname,
  role,
  status,
  membership_level,
  credits
) VALUES (
  current_setting('profile_bootstrap.user_id')::UUID,
  'profile-bootstrap-service-role@example.test',
  'profile-bootstrap-service-role',
  'user',
  'active',
  'free',
  0
);

DELETE FROM public.profiles
WHERE id = current_setting('profile_bootstrap.user_id')::UUID;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('profile_bootstrap.user_id'), true);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.profiles (
      id,
      email,
      nickname,
      role,
      status,
      membership_level,
      credits
    ) VALUES (
      current_setting('profile_bootstrap.user_id')::UUID,
      'profile-bootstrap-admin@example.test',
      'forbidden-admin',
      'admin',
      'active',
      'free',
      0
    );
    RAISE EXCEPTION 'authenticated admin profile insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.profiles (
      id,
      email,
      nickname,
      role,
      status,
      membership_level,
      credits
    ) VALUES (
      current_setting('profile_bootstrap.user_id')::UUID,
      'profile-bootstrap-paid@example.test',
      'forbidden-paid',
      'user',
      'active',
      'gold',
      0
    );
    RAISE EXCEPTION 'authenticated paid membership profile insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.profiles (
      id,
      email,
      nickname,
      role,
      status,
      membership_level,
      credits
    ) VALUES (
      current_setting('profile_bootstrap.user_id')::UUID,
      'profile-bootstrap-credits@example.test',
      'forbidden-credits',
      'user',
      'active',
      'free',
      100
    );
    RAISE EXCEPTION 'authenticated arbitrary credits profile insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.profiles (
      id,
      email,
      nickname,
      role,
      status,
      membership_level,
      credits
    ) VALUES (
      current_setting('profile_bootstrap.other_user_id')::UUID,
      'profile-bootstrap-other@example.test',
      'forbidden-other-user',
      'user',
      'active',
      'free',
      0
    );
    RAISE EXCEPTION 'authenticated cross-user profile insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      NULL;
  END;
END;
$$;

ROLLBACK;
