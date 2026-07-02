/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SUBSCRIPTION_CREDIT_GRANT_SELECT_COLUMNS = [
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
  'metadata',
];

const SUBSCRIPTION_CREDIT_GRANT_INSERT_COLUMNS = [
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
  'metadata',
];

const SUBSCRIPTION_CREDIT_GRANT_UPDATE_COLUMNS = [
  'status',
  'updated_at',
  'metadata',
];

const CREDIT_TRANSACTION_SELECT_COLUMNS = [
  'id',
  'amount',
  'user_id',
  'idempotency_key',
  'balance_after',
];

const CREDIT_TRANSACTION_UPDATE_COLUMNS = [
  'ledger_type',
  'reason_code',
  'counts_as_spend',
  'source_type',
  'source_id',
  'source_order_id',
  'source_refund_id',
  'grant_period_key',
  'metadata',
];

function readMigrationSql() {
  return readFileSync(
    new URL('../../db/migrations/0047_subscription_fulfillment_service_role_grants.sql', import.meta.url),
    'utf8',
  );
}

function readSmokeSql() {
  return readFileSync(
    new URL('../../db/tests/subscription_fulfillment_service_role_grants.sql', import.meta.url),
    'utf8',
  );
}

function extractColumnGrant(sql: string, privilege: string, table: string) {
  const grantBlock = sql.match(
    new RegExp(String.raw`GRANT ${privilege} \(([^)]*)\) ON TABLE public\.${table} TO service_role;`),
  )?.[1];

  expect(grantBlock).toBeDefined();

  return grantBlock
    ?.split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

function expectBefore(sql: string, before: string, after: string) {
  const beforeIndex = sql.indexOf(before);
  const afterIndex = sql.indexOf(after);

  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

describe('subscription fulfillment service-role grants migration', () => {
  it('is a forward-only grant posture migration without data writes or ledger spoofing', () => {
    const migrationSql = readMigrationSql();

    expect(migrationSql).toContain('Forward-only posture repair for PR #255 paid membership checkout');
    expect(migrationSql).toContain("to_regclass('public.subscription_credit_grants')");
    expect(migrationSql).toContain("to_regprocedure('public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)')");
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bschema_migrations\b/i);
    expect(migrationSql).not.toMatch(/\bsupabase_migrations\b/i);
  });

  it('revokes stale broad service_role grants before re-granting the least-privilege surface', () => {
    const migrationSql = readMigrationSql();
    const functionSignature = 'public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)';

    expectBefore(
      migrationSql,
      'REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM service_role;',
      'GRANT SELECT (id) ON TABLE public.profiles TO service_role;',
    );
    expectBefore(
      migrationSql,
      'REVOKE ALL PRIVILEGES ON TABLE public.subscription_credit_grants FROM service_role;',
      'GRANT SELECT (\n  id,\n  user_id,\n  membership_plan_id,',
    );
    expectBefore(
      migrationSql,
      'REVOKE ALL PRIVILEGES ON TABLE public.credit_transactions FROM service_role;',
      'GRANT SELECT (\n  id,\n  amount,\n  user_id,',
    );
    expectBefore(
      migrationSql,
      `REVOKE ALL ON FUNCTION ${functionSignature} FROM service_role;`,
      `GRANT EXECUTE ON FUNCTION ${functionSignature} TO service_role;`,
    );

    expect(migrationSql).toContain('REVOKE UPDATE (\n  membership_level,\n  credits\n) ON TABLE public.profiles FROM service_role;');
    expect(migrationSql).toContain('REVOKE UPDATE (\n  credits_granted,\n  credit_transaction_id\n) ON TABLE public.subscription_credit_grants FROM service_role;');
    expect(migrationSql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.credit_transactions FROM service_role;');
    expect(migrationSql).toContain('REVOKE UPDATE (\n  amount,\n  balance_after\n) ON TABLE public.credit_transactions FROM service_role;');
    expect(migrationSql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payment_orders FROM service_role;');
    expect(migrationSql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.user_subscriptions FROM service_role;');
  });

  it('grants service_role only the profile membership update surface required by fulfillment', () => {
    const migrationSql = readMigrationSql();

    expect(migrationSql).toContain('GRANT SELECT (id) ON TABLE public.profiles TO service_role;');
    expect(migrationSql).toContain('GRANT UPDATE (membership_level) ON TABLE public.profiles TO service_role;');
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*credits[^)]*\) ON TABLE public\.profiles TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*updated_at[^)]*\) ON TABLE public\.profiles TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+ON TABLE public\.profiles TO service_role/i);

    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(migrationSql).toContain(
        `REVOKE UPDATE (membership_level, credits) ON TABLE public.profiles FROM ${role};`,
      );
    }
  });

  it('grants service_role the named subscription_credit_grants columns used by grant and reversal paths', () => {
    const migrationSql = readMigrationSql();

    expect(extractColumnGrant(migrationSql, 'SELECT', 'subscription_credit_grants')).toEqual(
      SUBSCRIPTION_CREDIT_GRANT_SELECT_COLUMNS,
    );
    expect(extractColumnGrant(migrationSql, 'INSERT', 'subscription_credit_grants')).toEqual(
      SUBSCRIPTION_CREDIT_GRANT_INSERT_COLUMNS,
    );
    expect(extractColumnGrant(migrationSql, 'UPDATE', 'subscription_credit_grants')).toEqual(
      SUBSCRIPTION_CREDIT_GRANT_UPDATE_COLUMNS,
    );
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+ON TABLE public\.subscription_credit_grants TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*credits_granted[^)]*\) ON TABLE public\.subscription_credit_grants TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*credit_transaction_id[^)]*\) ON TABLE public\.subscription_credit_grants TO service_role/i);
  });

  it('keeps credit writes on the ledger RPC while allowing service_role semantic updates only', () => {
    const migrationSql = readMigrationSql();
    const functionSignature = 'public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)';

    expect(extractColumnGrant(migrationSql, 'SELECT', 'credit_transactions')).toEqual(
      CREDIT_TRANSACTION_SELECT_COLUMNS,
    );
    expect(extractColumnGrant(migrationSql, 'UPDATE', 'credit_transactions')).toEqual(
      CREDIT_TRANSACTION_UPDATE_COLUMNS,
    );
    expect(migrationSql).not.toMatch(/GRANT\s+INSERT\s+(?:\([^)]*\)\s+)?ON TABLE public\.credit_transactions TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+ON TABLE public\.credit_transactions TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*amount[^)]*\) ON TABLE public\.credit_transactions TO service_role/i);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE\s+\([^)]*balance_after[^)]*\) ON TABLE public\.credit_transactions TO service_role/i);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM PUBLIC;`);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM anon;`);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM authenticated;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${functionSignature} TO service_role;`);
  });

  it('conditionally repairs payment_orders and user_subscriptions service-role runtime posture without client writes', () => {
    const migrationSql = readMigrationSql();

    expect(migrationSql).toContain('Only repair those named');
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.payment_orders', 'SELECT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.payment_orders', 'INSERT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.payment_orders', 'UPDATE')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.user_subscriptions', 'SELECT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.user_subscriptions', 'INSERT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.user_subscriptions', 'UPDATE')");
    expect(migrationSql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_orders TO service_role;');
    expect(migrationSql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.user_subscriptions TO service_role;');

    for (const table of ['payment_orders', 'user_subscriptions', 'subscription_credit_grants', 'credit_transactions']) {
      for (const role of ['PUBLIC', 'anon', 'authenticated']) {
        expect(migrationSql).toContain(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${table} FROM ${role};`);
      }
    }
  });

  it('ships owner-gated rollback-only SQL smoke coverage', () => {
    const smokeSql = readSmokeSql();

    expect(smokeSql).toContain('Smoke test for 0047_subscription_fulfillment_service_role_grants.sql');
    expect(smokeSql).toContain('must not be run by Codex in this gate');
    expect(smokeSql).toContain("service_role retained table-level INSERT on profiles");
    expect(smokeSql).toContain("service_role retained table-level % on subscription_credit_grants");
    expect(smokeSql).toContain("service_role retained table-level % on credit_transactions");
    expect(smokeSql).toContain("has_column_privilege('service_role', 'public.profiles', 'membership_level', 'UPDATE')");
    expect(smokeSql).toContain("service_role can directly update profiles.credits");
    expect(smokeSql).toContain("service_role can directly insert credit_transactions");
    expect(smokeSql).toContain("service_role can update credit_transactions.amount");
    expect(smokeSql).toContain("service_role can update subscription_credit_grants.credits_granted");
    expect(smokeSql).toContain("has_function_privilege(\n    'service_role',\n    'public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',\n    'EXECUTE'\n  )");
    expect(smokeSql).toContain('ROLLBACK;');
  });
});
