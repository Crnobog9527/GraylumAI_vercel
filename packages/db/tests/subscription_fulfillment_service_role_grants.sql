/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Smoke test for 0047_subscription_fulfillment_service_role_grants.sql.
-- Run only against an owner-approved migrated staging database with psql; this
-- file is source-only in PR258 and must not be run by Codex in this gate. The
-- transaction rolls back all test data. Do not run against production.

BEGIN;

DO $$
DECLARE
  v_column TEXT;
  v_profile_select_columns TEXT[] := ARRAY[
    'id',
    'role',
    'credits',
    'status',
    'nickname',
    'email',
    'membership_level',
    'created_at'
  ];
  v_profile_insert_columns TEXT[] := ARRAY[
    'id',
    'email',
    'nickname',
    'role',
    'status',
    'membership_level',
    'credits'
  ];
  v_subscription_credit_grant_select_columns TEXT[] := ARRAY[
    'id',
    'user_id',
    'membership_plan_id',
    'stripe_subscription_id',
    'stripe_invoice_id',
    'billing_cycle',
    'grant_type',
    'grant_period_key',
    'period_index',
    'credits_granted',
    'status',
    'idempotency_key',
    'credit_transaction_id',
    'metadata'
  ];
  v_subscription_credit_grant_insert_columns TEXT[] := ARRAY[
    'user_id',
    'membership_plan_id',
    'stripe_subscription_id',
    'stripe_invoice_id',
    'billing_cycle',
    'grant_type',
    'grant_period_key',
    'period_start',
    'period_end',
    'period_index',
    'total_periods',
    'credits_granted',
    'status',
    'idempotency_key',
    'credit_transaction_id',
    'metadata'
  ];
  v_subscription_credit_grant_update_columns TEXT[] := ARRAY[
    'status',
    'updated_at',
    'metadata'
  ];
  v_credit_transaction_select_columns TEXT[] := ARRAY[
    'id',
    'amount',
    'user_id',
    'idempotency_key',
    'balance_after'
  ];
  v_credit_transaction_update_columns TEXT[] := ARRAY[
    'ledger_type',
    'reason_code',
    'counts_as_spend',
    'source_type',
    'source_id',
    'source_order_id',
    'source_refund_id',
    'grant_period_key',
    'metadata'
  ];
BEGIN
  FOREACH v_column IN ARRAY v_profile_select_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.profiles', v_column, 'SELECT') THEN
      RAISE EXCEPTION 'service_role cannot select profiles.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY v_profile_insert_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.profiles', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'service_role cannot insert profiles.%', v_column;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'service_role cannot delete guarded bootstrap profiles';
  END IF;

  IF NOT has_column_privilege('service_role', 'public.profiles', 'membership_level', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role cannot update profiles.membership_level';
  END IF;

  IF has_column_privilege('service_role', 'public.profiles', 'credits', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can directly update profiles.credits';
  END IF;

  IF has_table_privilege('service_role', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'service_role retained table-level SELECT on profiles';
  END IF;

  IF has_table_privilege('service_role', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'service_role retained table-level INSERT on profiles';
  END IF;

  IF has_table_privilege('service_role', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role retained table-level UPDATE on profiles';
  END IF;

  IF has_table_privilege('anon', 'public.profiles', 'INSERT')
    OR has_table_privilege('authenticated', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'client role can insert profiles';
  END IF;

  IF has_table_privilege('anon', 'public.profiles', 'DELETE')
    OR has_table_privilege('authenticated', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'client role can delete profiles';
  END IF;

  IF has_column_privilege('anon', 'public.profiles', 'membership_level', 'UPDATE')
    OR has_column_privilege('authenticated', 'public.profiles', 'membership_level', 'UPDATE') THEN
    RAISE EXCEPTION 'client role can update profiles.membership_level';
  END IF;

  IF has_column_privilege('anon', 'public.profiles', 'credits', 'UPDATE')
    OR has_column_privilege('authenticated', 'public.profiles', 'credits', 'UPDATE') THEN
    RAISE EXCEPTION 'client role can update profiles.credits';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.payment_orders', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.payment_orders', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.payment_orders', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role payment_orders SELECT/INSERT/UPDATE posture is incomplete';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.user_subscriptions', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.user_subscriptions', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.user_subscriptions', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role user_subscriptions SELECT/INSERT/UPDATE posture is incomplete';
  END IF;

  IF has_table_privilege('service_role', 'public.payment_orders', 'DELETE')
    OR has_table_privilege('service_role', 'public.user_subscriptions', 'DELETE') THEN
    RAISE EXCEPTION 'service_role retained payment/subscription DELETE posture';
  END IF;

  FOREACH v_column IN ARRAY v_subscription_credit_grant_select_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.subscription_credit_grants', v_column, 'SELECT') THEN
      RAISE EXCEPTION 'service_role cannot select subscription_credit_grants.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY v_subscription_credit_grant_insert_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.subscription_credit_grants', v_column, 'INSERT') THEN
      RAISE EXCEPTION 'service_role cannot insert subscription_credit_grants.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY v_subscription_credit_grant_update_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.subscription_credit_grants', v_column, 'UPDATE') THEN
      RAISE EXCEPTION 'service_role cannot update subscription_credit_grants.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY v_credit_transaction_select_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.credit_transactions', v_column, 'SELECT') THEN
      RAISE EXCEPTION 'service_role cannot select credit_transactions.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY v_credit_transaction_update_columns LOOP
    IF NOT has_column_privilege('service_role', 'public.credit_transactions', v_column, 'UPDATE') THEN
      RAISE EXCEPTION 'service_role cannot update credit_transactions.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('service_role', 'public.subscription_credit_grants', v_column) THEN
      RAISE EXCEPTION 'service_role retained table-level % on subscription_credit_grants', v_column;
    END IF;

    IF has_table_privilege('service_role', 'public.credit_transactions', v_column) THEN
      RAISE EXCEPTION 'service_role retained table-level % on credit_transactions', v_column;
    END IF;
  END LOOP;

  IF has_table_privilege('service_role', 'public.credit_transactions', 'INSERT') THEN
    RAISE EXCEPTION 'service_role can directly insert credit_transactions';
  END IF;

  IF has_column_privilege('service_role', 'public.credit_transactions', 'amount', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can update credit_transactions.amount';
  END IF;

  IF has_column_privilege('service_role', 'public.credit_transactions', 'balance_after', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can update credit_transactions.balance_after';
  END IF;

  IF has_column_privilege('service_role', 'public.subscription_credit_grants', 'credits_granted', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can update subscription_credit_grants.credits_granted';
  END IF;

  IF has_column_privilege('service_role', 'public.subscription_credit_grants', 'credit_transaction_id', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role can update subscription_credit_grants.credit_transaction_id';
  END IF;

  FOREACH v_column IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.subscription_credit_grants', v_column)
      OR has_table_privilege('authenticated', 'public.subscription_credit_grants', v_column) THEN
      RAISE EXCEPTION 'client role can % subscription_credit_grants', v_column;
    END IF;

    IF has_table_privilege('anon', 'public.payment_orders', v_column)
      OR has_table_privilege('authenticated', 'public.payment_orders', v_column) THEN
      RAISE EXCEPTION 'client role can % payment_orders', v_column;
    END IF;

    IF has_table_privilege('anon', 'public.user_subscriptions', v_column)
      OR has_table_privilege('authenticated', 'public.user_subscriptions', v_column) THEN
      RAISE EXCEPTION 'client role can % user_subscriptions', v_column;
    END IF;

    IF has_table_privilege('anon', 'public.credit_transactions', v_column)
      OR has_table_privilege('authenticated', 'public.credit_transactions', v_column) THEN
      RAISE EXCEPTION 'client role can % credit_transactions', v_column;
    END IF;
  END LOOP;

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

ROLLBACK;
