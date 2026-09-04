/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- psql fixture test: ONLY run in an empty disposable local database, never
-- against staging/production. All fixture objects and grants roll back.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE service_role;
CREATE ROLE anon;
CREATE ROLE authenticated;
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

CREATE TABLE public.billing_history (
  operation_type text, amount integer, created_at timestamptz, private_fixture text
);
CREATE TABLE public.credit_transactions (
  id text, user_id text, amount integer, type text, ledger_type text,
  reason_code text, counts_as_spend boolean, source_type text, source_order_id text,
  grant_period_key text, idempotency_key text, balance_before integer,
  balance_after integer, metadata jsonb, created_at timestamptz, description text,
  private_fixture text
);
CREATE TABLE public.subscription_credit_grants (
  id text, user_id text, stripe_subscription_id text, stripe_invoice_id text,
  billing_cycle text, grant_type text, grant_period_key text, period_index integer,
  total_periods integer, credits_granted integer, consumed_amount integer,
  accounting_state text, status text, idempotency_key text, credit_transaction_id text,
  metadata jsonb, created_at timestamptz, updated_at timestamptz, private_fixture text
);
ALTER TABLE public.billing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_credit_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_read ON public.credit_transactions FOR SELECT TO authenticated USING (true);

-- Representative pre-existing column grants: migration must preserve these,
-- including client reads and an unrelated server write, without widening them.
GRANT SELECT (id, user_id, amount, balance_after, idempotency_key)
  ON public.credit_transactions TO service_role;
GRANT SELECT (
  id, user_id, stripe_subscription_id, stripe_invoice_id, billing_cycle, grant_type,
  grant_period_key, period_index, total_periods, credits_granted, consumed_amount,
  accounting_state, status, idempotency_key, credit_transaction_id, metadata, created_at
) ON public.subscription_credit_grants TO service_role;
GRANT SELECT (id) ON public.credit_transactions TO authenticated;
GRANT UPDATE (metadata) ON public.credit_transactions TO service_role;
INSERT INTO public.billing_history VALUES ('settle', -10, '2026-09-03', 'unchanged');
INSERT INTO public.credit_transactions (id, amount) VALUES ('fixture', -10);
INSERT INTO public.subscription_credit_grants (id, credits_granted) VALUES ('fixture', 10);

CREATE TEMP TABLE before_acl AS
SELECT c.relname, 0 AS attnum, x.grantee, x.privilege_type, x.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
WHERE c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT c.relname, a.attnum, x.grantee, x.privilege_type, x.is_grantable
FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
CROSS JOIN LATERAL aclexplode(a.attacl) x
WHERE c.relnamespace = 'public'::regnamespace
  AND NOT (x.grantee = 'service_role'::regrole AND x.privilege_type = 'SELECT');
CREATE TEMP TABLE before_rows AS
SELECT 'billing_history' AS table_name, to_jsonb(t) AS row_data FROM public.billing_history t
UNION ALL SELECT 'credit_transactions', to_jsonb(t) FROM public.credit_transactions t
UNION ALL SELECT 'subscription_credit_grants', to_jsonb(t) FROM public.subscription_credit_grants t;
CREATE TEMP TABLE before_policies AS SELECT * FROM pg_policies WHERE schemaname = 'public';
CREATE TEMP TABLE before_columns AS
SELECT c.relname, a.attname, a.atttypid, a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated
FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped;

\ir ../migrations/0063_bill_1_reconciliation_select_contract.sql
-- A second application proves idempotency, without an additional migration file.
\ir ../migrations/0063_bill_1_reconciliation_select_contract.sql

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['billing_history', 'credit_transactions', 'subscription_credit_grants'] LOOP
    IF has_table_privilege('service_role', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'Unexpected table SELECT on %', v_table;
    END IF;
    IF has_column_privilege('service_role', 'public.' || v_table, 'private_fixture', 'SELECT') THEN
      RAISE EXCEPTION 'Unexpected unrelated column SELECT on %', v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
      RAISE EXCEPTION 'RLS changed on %', v_table;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE after_acl AS
SELECT c.relname, 0 AS attnum, x.grantee, x.privilege_type, x.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
WHERE c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT c.relname, a.attnum, x.grantee, x.privilege_type, x.is_grantable
FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
CROSS JOIN LATERAL aclexplode(a.attacl) x
WHERE c.relnamespace = 'public'::regnamespace
  AND NOT (x.grantee = 'service_role'::regrole AND x.privilege_type = 'SELECT');
CREATE TEMP TABLE after_rows AS
SELECT 'billing_history' AS table_name, to_jsonb(t) AS row_data FROM public.billing_history t
UNION ALL SELECT 'credit_transactions', to_jsonb(t) FROM public.credit_transactions t
UNION ALL SELECT 'subscription_credit_grants', to_jsonb(t) FROM public.subscription_credit_grants t;
DO $$
BEGIN
  IF EXISTS ((TABLE before_acl EXCEPT TABLE after_acl) UNION ALL (TABLE after_acl EXCEPT TABLE before_acl)) THEN
    RAISE EXCEPTION 'Client, table-level, grant-option or non-SELECT ACL changed';
  END IF;
  IF EXISTS ((TABLE before_rows EXCEPT TABLE after_rows) UNION ALL (TABLE after_rows EXCEPT TABLE before_rows)) THEN
    RAISE EXCEPTION 'Business rows changed';
  END IF;
  IF EXISTS (
    (TABLE before_columns EXCEPT
      SELECT c.relname, a.attname, a.atttypid, a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped)
    UNION ALL
    (SELECT c.relname, a.attname, a.atttypid, a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
      EXCEPT TABLE before_columns)
  ) THEN
    RAISE EXCEPTION 'Schema columns changed';
  END IF;
  IF EXISTS (
    (TABLE before_policies EXCEPT SELECT * FROM pg_policies WHERE schemaname = 'public')
    UNION ALL
    (SELECT * FROM pg_policies WHERE schemaname = 'public' EXCEPT TABLE before_policies)
  ) THEN
    RAISE EXCEPTION 'Policies changed';
  END IF;
END $$;

SET LOCAL ROLE service_role;
SELECT operation_type, amount, created_at FROM public.billing_history WHERE false;
SELECT amount, type, ledger_type, reason_code, counts_as_spend, source_type,
  description, idempotency_key, created_at FROM public.credit_transactions WHERE false;
SELECT id, user_id, amount, type, ledger_type, reason_code, counts_as_spend,
  source_type, source_order_id, grant_period_key, idempotency_key, balance_before,
  balance_after, metadata, created_at FROM public.credit_transactions WHERE false;
SELECT id, user_id, stripe_subscription_id, stripe_invoice_id, billing_cycle,
  grant_type, grant_period_key, period_index, total_periods, credits_granted,
  consumed_amount, accounting_state, status, idempotency_key, credit_transaction_id,
  metadata, created_at, updated_at FROM public.subscription_credit_grants WHERE false;
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['billing_history', 'credit_transactions', 'subscription_credit_grants'] LOOP
    BEGIN
      EXECUTE format('SELECT * FROM public.%I WHERE false', v_table);
      RAISE EXCEPTION 'Broad read unexpectedly succeeded: %', v_table;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END $$;
RESET ROLE;
ROLLBACK;
\echo BILL_1_COLUMN_SELECT_CONTRACT_PASS
