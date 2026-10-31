/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

const CREDIT_TRANSACTION_PAGE_SIZE = 1000;

type DailyCreditTransactionRow = {
  id?: string | null;
  amount?: number | string | null;
  type?: string | null;
  ledger_type?: string | null;
  reason_code?: string | null;
  counts_as_spend?: boolean | null;
  source_type?: string | null;
  description?: string | null;
  idempotency_key?: string | null;
  created_at?: string | null;
};

function sumFixedPriceSpend(rows: DailyCreditTransactionRow[], prefix: string) {
  let total = 0;
  for (const row of rows) {
    const key = typeof row.idempotency_key === 'string' ? row.idempotency_key : '';
    if (!key.startsWith(prefix) || !key.endsWith(':spend')) continue;
    const amount = row.amount;
    if (row.type !== 'consumption' || row.ledger_type !== 'spend' || row.reason_code !== 'bill2_spend'
      || row.source_type !== 'ai_task' || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount >= 0
      || !Number.isSafeInteger(total - amount)) throw new Error('Invalid fixed price reconciliation ledger');
    total -= amount;
  }
  return total;
}

async function readDailyCreditTransactions(supabase: SupabaseClient, start: string, end: string) {
  const rows: DailyCreditTransactionRow[] = [];
  for (let offset = 0; ; offset += CREDIT_TRANSACTION_PAGE_SIZE) {
    const result = await supabase.from('credit_transactions')
      .select('id, amount, type, ledger_type, reason_code, counts_as_spend, source_type, description, idempotency_key, created_at',
        { count: 'exact' })
      .range(offset, offset + CREDIT_TRANSACTION_PAGE_SIZE - 1)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .gte('created_at', start).lt('created_at', end);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as DailyCreditTransactionRow[];
    if (!Number.isSafeInteger(result.count) || (result.count as number) < rows.length + page.length) {
      throw new Error('Invalid credit transaction reconciliation count');
    }
    rows.push(...page);
    if (rows.length === result.count) return rows;
    if (rows.length > (result.count as number) || page.length === 0) {
      throw new Error('Incomplete credit transaction reconciliation page');
    }
  }
}

export async function readDailyBillingCreditSources(supabase: SupabaseClient, start: string, end: string) {
  // billing_history settle totals are counted in the database (billing_reconcile_day, dailyBillingTotals.ts).
  const [creditTransactions, researchResult] = await Promise.all([
      readDailyCreditTransactions(supabase, start, end),
      supabase.rpc('research_billing_summary', { p_start: start, p_end: end }),
    ]);

  if (researchResult.error) throw researchResult.error;

  const research = researchResult.data as { count: number; credits: number; turnOtherCredits?: number } | null;
  // turnOtherCredits: absent until migration 0437 is applied.
  const turnOtherCredits = research?.turnOtherCredits ?? 0;
  if (!research || !Number.isSafeInteger(research.count) || research.count < 0
    || !Number.isSafeInteger(research.credits) || research.credits < 0
    || !Number.isSafeInteger(turnOtherCredits) || turnOtherCredits < 0) {
    throw new Error('Invalid research reconciliation totals');
  }
  return {
    creditTransactions,
    research,
    turnOtherCredits,
    reportFixedPriceCredits: sumFixedPriceSpend(creditTransactions, 'report:'),
    fusionReviewFixedPriceCredits: sumFixedPriceSpend(creditTransactions, 'fusion-review:'),
  };
}
