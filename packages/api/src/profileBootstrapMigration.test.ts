/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BOOTSTRAP_COLUMNS = [
  'id',
  'email',
  'nickname',
  'role',
  'status',
  'membership_level',
  'credits',
];

function readMigrationSql() {
  return readFileSync(
    new URL('../../db/migrations/0046_profile_bootstrap_service_role_grants.sql', import.meta.url),
    'utf8',
  );
}

function readSmokeSql() {
  return readFileSync(
    new URL('../../db/tests/profile_bootstrap_service_role_grants.sql', import.meta.url),
    'utf8',
  );
}

function extractServiceRoleInsertColumns(sql: string) {
  const grantBlock = sql.match(
    /GRANT INSERT \(([\s\S]*?)\) ON TABLE public\.profiles TO service_role;/,
  )?.[1];

  expect(grantBlock).toBeDefined();

  return grantBlock
    ?.split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

describe('profile bootstrap service-role grants migration', () => {
  it('grants service_role the minimum profile bootstrap surface', () => {
    const migrationSql = readMigrationSql();

    expect(migrationSql).toContain('Forward-only posture repair for PR #250 server-side ensureProfile');
    expect(migrationSql).toContain('GRANT SELECT ON TABLE public.profiles TO service_role;');
    expect(migrationSql).toContain('GRANT DELETE ON TABLE public.profiles TO service_role;');
    expect(migrationSql).toContain('GRANT SELECT ON TABLE public.credit_transactions TO service_role;');
    expect(extractServiceRoleInsertColumns(migrationSql)).toEqual(BOOTSTRAP_COLUMNS);
    expect(migrationSql).not.toMatch(/GRANT\s+UPDATE[\s\S]*ON TABLE public\.profiles TO service_role/i);
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\s+public\.profiles\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+public\.profiles\b/i);
  });

  it('keeps anon and authenticated profile writes closed', () => {
    const migrationSql = readMigrationSql();

    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(migrationSql).toContain(`REVOKE INSERT ON TABLE public.profiles FROM ${role};`);
      expect(migrationSql).toContain(`REVOKE DELETE ON TABLE public.profiles FROM ${role};`);
    }

    expect(migrationSql).toContain('DROP POLICY IF EXISTS "profiles_insert_own_zero_credits"');
    expect(migrationSql).not.toMatch(/CREATE POLICY "profiles_insert_own_zero_credits"/);
    expect(migrationSql).not.toMatch(/GRANT\s+INSERT[\s\S]*ON TABLE public\.profiles TO authenticated/i);
    expect(migrationSql).not.toMatch(/GRANT\s+DELETE[\s\S]*ON TABLE public\.profiles TO authenticated/i);
    expect(migrationSql).not.toMatch(/GRANT\s+INSERT[\s\S]*ON TABLE public\.profiles TO anon/i);
  });

  it('keeps the opening grant service-role RPC contract intact', () => {
    const migrationSql = readMigrationSql();
    const functionSignature = 'public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT)';

    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM PUBLIC;`);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM anon;`);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${functionSignature} FROM authenticated;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${functionSignature} TO service_role;`);
    expect(migrationSql).not.toMatch(/\bGRANT\s+EXECUTE[\s\S]*TO authenticated/i);
    expect(migrationSql).not.toMatch(/\bGRANT\s+EXECUTE[\s\S]*TO anon/i);
  });

  it('keeps service_role cleanup delete behind an opening-grant ledger safety check', () => {
    const migrationSql = readMigrationSql();
    const trpcSource = readFileSync(new URL('./trpc.ts', import.meta.url), 'utf8');

    expect(migrationSql).toContain('SELECT opening-grant ledger state before any cleanup delete');
    expect(migrationSql).toContain('DELETE only a still-safe zero-credit bootstrap profile');
    expect(migrationSql).toContain('GRANT SELECT ON TABLE public.credit_transactions TO service_role;');
    expect(trpcSource).toContain("from('credit_transactions')");
    expect(trpcSource).toContain("eq('idempotency_key', getOpeningGrantIdempotencyKey(userId))");
    expect(trpcSource).toContain(".eq('role', 'user')");
    expect(trpcSource).toContain(".eq('status', 'active')");
    expect(trpcSource).toContain(".eq('membership_level', 'free')");
    expect(trpcSource).toContain(".eq('credits', 0)");
    expect(trpcSource.indexOf('await findOpeningGrantLedgerEntry(ctx, userId)')).toBeLessThan(
      trpcSource.indexOf('await cleanupSafeBootstrapProfile(ctx, userId)'),
    );
    expect(trpcSource).toContain('profile_opening_grant_already_recorded');
  });

  it('ships rollback-only SQL smoke coverage for the PR251 posture gate', () => {
    const smokeSql = readSmokeSql();

    expect(smokeSql).toContain('Smoke test for 0046_profile_bootstrap_service_role_grants.sql');
    expect(smokeSql).toContain("has_table_privilege('service_role', 'public.profiles', 'SELECT')");
    expect(smokeSql).toContain("has_table_privilege('service_role', 'public.profiles', 'DELETE')");
    expect(smokeSql).toContain("has_table_privilege('service_role', 'public.credit_transactions', 'SELECT')");
    expect(smokeSql).toContain("has_column_privilege('service_role', 'public.profiles', v_column, 'INSERT')");
    expect(smokeSql).toContain("has_column_privilege('anon', 'public.profiles', v_column, 'INSERT')");
    expect(smokeSql).toContain("has_column_privilege('authenticated', 'public.profiles', v_column, 'INSERT')");
    expect(smokeSql).toContain('legacy authenticated profile insert policy is still present');
    expect(smokeSql).toContain('authenticated admin profile insert unexpectedly succeeded');
    expect(smokeSql).toContain('authenticated paid membership profile insert unexpectedly succeeded');
    expect(smokeSql).toContain('authenticated arbitrary credits profile insert unexpectedly succeeded');
    expect(smokeSql).toContain('authenticated cross-user profile insert unexpectedly succeeded');
    expect(smokeSql).toContain("idempotency_key = 'opening_grant:' || current_setting('profile_bootstrap.user_id')");
    expect(smokeSql).toContain("AND role = 'user'");
    expect(smokeSql).toContain("AND status = 'active'");
    expect(smokeSql).toContain("AND membership_level = 'free'");
    expect(smokeSql).toContain('AND credits = 0');
    expect(smokeSql).toContain('ROLLBACK;');
  });
});
