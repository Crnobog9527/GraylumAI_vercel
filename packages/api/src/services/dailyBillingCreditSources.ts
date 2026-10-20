/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function readDailyBillingCreditSources(supabase: SupabaseClient, start: string, end: string) {
  const [billingHistoryResult, creditTransactionsResult, researchResult, fixedPriceResult] = await Promise.all([
      supabase.from('billing_history').select('operation_type, amount, created_at').gte('created_at', start).lt('created_at', end),
      supabase.from('credit_transactions')
        .select('amount, type, ledger_type, reason_code, counts_as_spend, source_type, description, idempotency_key, created_at')
        .gte('created_at', start).lt('created_at', end),
      supabase.rpc('research_billing_summary', { p_start: start, p_end: end }),
      supabase.rpc('daily_billing_fixed_price_summary', { p_start: start, p_end: end }),
    ]);

  if (billingHistoryResult.error) throw billingHistoryResult.error;
  if (creditTransactionsResult.error) throw creditTransactionsResult.error;
  if (researchResult.error) throw researchResult.error;
  if (fixedPriceResult.error) throw fixedPriceResult.error;

  const research = researchResult.data as { count: number; credits: number } | null;
  if (!research || !Number.isSafeInteger(research.count) || research.count < 0
    || !Number.isSafeInteger(research.credits) || research.credits < 0) {
    throw new Error('Invalid research reconciliation totals');
  }
  const fixedPrices = fixedPriceResult.data as { reportFixedPriceCredits: number; fusionReviewFixedPriceCredits: number } | null;
  if (!fixedPrices || !Number.isSafeInteger(fixedPrices.reportFixedPriceCredits) || fixedPrices.reportFixedPriceCredits < 0
    || !Number.isSafeInteger(fixedPrices.fusionReviewFixedPriceCredits) || fixedPrices.fusionReviewFixedPriceCredits < 0) {
    throw new Error('Invalid fixed price reconciliation totals');
  }

  return {
    billingHistory: billingHistoryResult.data ?? [],
    creditTransactions: creditTransactionsResult.data ?? [],
    research,
    reportFixedPriceCredits: fixedPrices.reportFixedPriceCredits,
    fusionReviewFixedPriceCredits: fixedPrices.fusionReviewFixedPriceCredits,
  };
}
