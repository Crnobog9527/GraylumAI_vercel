/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBillingEngineV15ReadinessAudit, runDailyBillingReconciliation } from '../billingReconciliation';

const migration = readFileSync(
  join(__dirname, '../../../../db/migrations/0063_bill_1_reconciliation_select_contract.sql'),
  'utf8',
);
const executableSql = migration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const grants = [...executableSql.matchAll(
  /GRANT SELECT \(\s*([\s\S]*?)\s*\) ON TABLE public\.(\w+) TO service_role;/g,
)];
const columnsByTable = Object.fromEntries(grants.map((match) => [
  match[2], match[1].split(',').map((column) => column.trim()).sort(),
]));
const requiredColumns = {
  billing_history: ['operation_type', 'amount', 'created_at'],
  credit_transactions: [
    'id', 'user_id', 'amount', 'type', 'ledger_type', 'reason_code', 'counts_as_spend',
    'source_type', 'source_order_id', 'grant_period_key', 'idempotency_key',
    'balance_before', 'balance_after', 'metadata', 'created_at', 'description',
  ],
  subscription_credit_grants: [
    'id', 'user_id', 'stripe_subscription_id', 'stripe_invoice_id', 'billing_cycle',
    'grant_type', 'grant_period_key', 'period_index', 'total_periods', 'credits_granted',
    'consumed_amount', 'accounting_state', 'status', 'idempotency_key',
    'credit_transaction_id', 'metadata', 'created_at', 'updated_at',
  ],
};
const missingColumns = {
  billing_history: ['operation_type', 'amount', 'created_at'],
  credit_transactions: [
    'type', 'ledger_type', 'reason_code', 'counts_as_spend', 'source_type',
    'source_order_id', 'grant_period_key', 'balance_before', 'metadata', 'created_at', 'description',
  ],
  subscription_credit_grants: ['updated_at'],
};
// Derive pre-existing SELECT grants from repository migrations, not from the
// new migration under test or a mock that silently permits the whole table.
const priorSql = [
  '0047_subscription_fulfillment_service_role_grants.sql',
  '0056_refund_1b_service_role_select_contract_repair.sql',
  '0060_refund_1b_post_merge_forward_repair.sql',
].map((name) => readFileSync(join(__dirname, '../../../../db/migrations', name), 'utf8')).join('\n');
const effectiveColumns = Object.fromEntries(Object.entries(columnsByTable).map(([table, columns]) => [
  table,
  new Set([
    ...columns,
    ...[...priorSql.matchAll(new RegExp(
      `GRANT SELECT \\(\\s*([^)]*?)\\s*\\) ON TABLE public\\.${table} TO service_role;`, 'g',
    ))].flatMap((match) => match[1].split(',').map((column) => column.trim())),
  ]),
]));

// Project only requested columns so a missing legacy classifier input is observable.
function permissionScopedClient(rows: Record<string, Record<string, unknown>[]> = {}, deniedTable?: string) {
  const selections: Array<{ table: string; columns: string[] }> = [];
  const client = {
    from(table: string) {
      let columns: string[] = [];
      const result = () => ({
        data: (rows[table] ?? []).map((row) => Object.fromEntries(
          columns.filter((column) => column in row).map((column) => [column, row[column]]),
        )),
        count: (rows[table] ?? []).length,
        error: table === deniedTable ? { code: '42501', message: `permission denied for table ${table}` } : null,
      });
      const builder = {
        select(projection: string) {
          columns = projection.split(',').map((column) => column.trim());
          expect(columns).not.toContain('*');
          if (columnsByTable[table]) {
            expect(columns.every((column) => effectiveColumns[table].has(column))).toBe(true);
          }
          selections.push({ table, columns });
          return builder;
        },
        eq: () => builder,
        gte: () => builder,
        lt: async () => result(),
        limit: async () => result(),
        maybeSingle: async () => ({ data: { value: '2026-01-01T00:00:00.000Z' }, error: null }),
      };
      return builder;
    },
  };
  return { client: client as any, selections };
}

describe('BILL-1 column SELECT permission contract', () => {
  it('grants only the missing required columns on three tables, only to service_role', () => {
    expect(grants).toHaveLength(3);
    expect(Object.keys(columnsByTable).sort()).toEqual(Object.keys(requiredColumns).sort());
    for (const [table, columns] of Object.entries(missingColumns)) {
      expect(columnsByTable[table]).toEqual([...columns].sort());
    }
    for (const [table, columns] of Object.entries(requiredColumns)) {
      expect(columns.filter((column) => !effectiveColumns[table].has(column))).toEqual([]);
    }
    // Every GRANT must be one of the exact column-scoped SELECT statements above.
    let remainder = executableSql;
    for (const grant of grants) remainder = remainder.replace(grant[0], '');
    expect(remainder).not.toMatch(/\bGRANT\b/i);
    expect(executableSql).not.toMatch(/\b(?:REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/i);
    expect(executableSql).not.toMatch(/\b(?:ALTER|CREATE|DROP|POLICY|FUNCTION|EXECUTE)\b/i);
    expect(executableSql).not.toMatch(/\bTO\s+(?:PUBLIC|anon|authenticated)\b/i);
    expect(executableSql).not.toMatch(/\bGRANT\s+SELECT\s+ON\b/i);
  });

  it('asserts every affected column with has_column_privilege and fails on a missing grant', () => {
    const assertions = executableSql.slice(executableSql.indexOf('DO $$'));
    expect(assertions).toContain('FOREACH v_column IN ARRAY v_contract.columns');
    expect(assertions).toContain("IF NOT has_column_privilege(\n        'service_role',");
    expect(assertions).toContain("'public.' || v_contract.table_name");
    expect(assertions).toContain('RAISE EXCEPTION');
    expect(assertions).toContain("IF has_table_privilege('service_role', 'public.' || v_contract.table_name, 'SELECT') THEN");
    for (const [table, columns] of Object.entries(requiredColumns)) {
      const match = assertions.match(new RegExp(`\\('${table}', ARRAY\\[([\\s\\S]*?)\\]\\)`));
      expect(match).not.toBeNull();
      expect([...match![1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).sort())
        .toEqual([...columns].sort());
    }
  });

  it('covers the actual daily and readiness projections without unused granted columns', async () => {
    const { client, selections } = permissionScopedClient();
    expect((await runDailyBillingReconciliation(client)).success).toBe(true);
    expect((await runBillingEngineV15ReadinessAudit(client)).success).toBe(true);
    for (const [table, columns] of Object.entries(requiredColumns)) {
      const used = new Set(selections.filter((selection) => selection.table === table)
        .flatMap((selection) => selection.columns));
      expect([...used].sort()).toEqual([...columns].sort());
    }
    expect(selections.find((selection) => selection.table === 'credit_transactions')?.columns).toEqual([
      'amount', 'type', 'ledger_type', 'reason_code', 'counts_as_spend', 'source_type',
      'description', 'idempotency_key', 'created_at',
    ]);
  });

  it('preserves legacy spend, refund, adjustment and top-up classification under projection', async () => {
    const { client } = permissionScopedClient({
      credit_transactions: [
        { amount: -10, type: 'deduction', description: 'AI 对话消费' },
        { amount: -20, type: 'deduction', idempotency_key: 'ai_spend:legacy' },
        { amount: -50, type: 'deduction', description: 'stripe refund', counts_as_spend: true },
        { amount: -70, type: 'deduction', description: 'admin adjustment' },
        { amount: -80, type: 'deduction', idempotency_key: 'admin_credit_deduction:legacy' },
        { amount: 100, type: 'addition', source_type: 'stripe_checkout', description: 'credit package' },
        { amount: 200, type: 'purchase', description: 'admin adjustment' },
        { amount: 300, type: 'addition', ledger_type: 'grant', reason_code: 'topup_purchase' },
      ],
    });
    const result = await runDailyBillingReconciliation(client);
    expect(result.summary.deductionCredits).toBe(30);
    expect(result.summary.purchaseCredits).toBe(400);
  });

  it.each(['billing_history', 'credit_transactions'])('does not suppress daily permission errors on %s', async (table) => {
    const { client } = permissionScopedClient({}, table);
    await expect(runDailyBillingReconciliation(client)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['credit_transactions', 'subscription_credit_grants'])('does not classify unreadable %s as historical', async (table) => {
    const { client } = permissionScopedClient({}, table);
    await expect(runBillingEngineV15ReadinessAudit(client)).rejects.toMatchObject({ code: '42501' });
  });
});
