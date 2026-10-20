/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

function sumChargedFees(rows: Array<{ state: string; charged_credits: number | null }>) {
  let total = 0;
  for (const row of rows) {
    if (row.state !== 'charged') continue;
    const amount = row.charged_credits;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0
      || !Number.isSafeInteger(total + amount)) throw new Error('Invalid fixed price reconciliation total');
    total += amount;
  }
  return total;
}

export async function readDailyBillingCreditSources(supabase: SupabaseClient, start: string, end: string) {
  const [billingHistoryResult, creditTransactionsResult, researchResult, reportFeesResult, fusionReviewFeesResult] =
    await Promise.all([
      supabase.from('billing_history').select('operation_type, amount, created_at').gte('created_at', start).lt('created_at', end),
      supabase.from('credit_transactions')
        .select('amount, type, ledger_type, reason_code, counts_as_spend, source_type, description, idempotency_key, created_at')
        .gte('created_at', start).lt('created_at', end),
      supabase.rpc('research_billing_summary', { p_start: start, p_end: end }),
      supabase.from('report_fees').select('state, charged_credits, settled_at').eq('state', 'charged')
        .gte('settled_at', start).lt('settled_at', end),
      supabase.from('fusion_review_fees').select('state, charged_credits, settled_at').eq('state', 'charged')
        .gte('settled_at', start).lt('settled_at', end),
    ]);

  if (billingHistoryResult.error) throw billingHistoryResult.error;
  if (creditTransactionsResult.error) throw creditTransactionsResult.error;
  if (researchResult.error) throw researchResult.error;
  if (reportFeesResult.error) throw reportFeesResult.error;
  if (fusionReviewFeesResult.error) throw fusionReviewFeesResult.error;

  const research = researchResult.data as { count: number; credits: number } | null;
  if (!research || !Number.isSafeInteger(research.count) || research.count < 0
    || !Number.isSafeInteger(research.credits) || research.credits < 0) {
    throw new Error('Invalid research reconciliation totals');
  }

  return {
    billingHistory: billingHistoryResult.data ?? [],
    creditTransactions: creditTransactionsResult.data ?? [],
    research,
    reportFixedPriceCredits: sumChargedFees(reportFeesResult.data ?? []),
    fusionReviewFixedPriceCredits: sumChargedFees(fusionReviewFeesResult.data ?? []),
  };
}
