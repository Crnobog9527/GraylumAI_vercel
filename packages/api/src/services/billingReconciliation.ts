import type { SupabaseClient } from '@supabase/supabase-js';
import {
  countsAsCreditSpend,
  normalizeCreditLedgerType,
} from './creditLedger';

export interface BillingReconciliationSummary {
  successfulAiRequests: number;
  tokenStatsCount: number;
  tokenStatsCredits: number;
  settledCredits: number;
  deductionCredits: number;
  completedPaymentOrders: number;
  completedPaymentAmount: number;
  purchaseCredits: number;
  webSearchCount: number;
}

export interface BillingReconciliationResult {
  periodStart: string;
  periodEnd: string;
  success: boolean;
  mismatches: string[];
  summary: BillingReconciliationSummary;
}

function sumInteger(values: Array<number | string | null | undefined>) {
  return values.reduce<number>((sum, value) => {
    if (typeof value === 'number') return sum + value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? sum + parsed : sum;
    }
    return sum;
  }, 0);
}

function getUtcDayWindow(targetDate?: Date) {
  const base = targetDate ? new Date(targetDate) : new Date();
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export async function runDailyBillingReconciliation(
  supabase: SupabaseClient,
  targetDate?: Date,
): Promise<BillingReconciliationResult> {
  const { start, end } = getUtcDayWindow(targetDate);

  const [tokenStatsResult, aiUsageResult, billingHistoryResult, creditTransactionsResult, paymentOrdersResult] =
    await Promise.all([
      supabase
        .from('token_stats')
        .select('total_credits, web_search_count, created_at')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('ai_usage_logs')
        .select('status, created_at')
        .eq('status', 'success')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('billing_history')
        .select('operation_type, amount, created_at')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('credit_transactions')
        .select('*')
        .gte('created_at', start)
        .lt('created_at', end),
      supabase
        .from('payment_orders')
        .select('status, amount_total, created_at')
        .gte('created_at', start)
        .lt('created_at', end),
    ]);

  if (tokenStatsResult.error) throw tokenStatsResult.error;
  if (aiUsageResult.error) throw aiUsageResult.error;
  if (billingHistoryResult.error) throw billingHistoryResult.error;
  if (creditTransactionsResult.error) throw creditTransactionsResult.error;
  if (paymentOrdersResult.error) throw paymentOrdersResult.error;

  const tokenStats = tokenStatsResult.data ?? [];
  const aiUsageLogs = aiUsageResult.data ?? [];
  const billingHistory = billingHistoryResult.data ?? [];
  const creditTransactions = creditTransactionsResult.data ?? [];
  const paymentOrders = paymentOrdersResult.data ?? [];

  const successfulAiRequests = aiUsageLogs.length;
  const tokenStatsCount = tokenStats.length;
  const tokenStatsCredits = sumInteger(tokenStats.map((row) => row.total_credits ?? 0));
  const webSearchCount = sumInteger(tokenStats.map((row) => row.web_search_count ?? 0));

  const settledCredits = Math.abs(sumInteger(
    billingHistory
      .filter((row) => row.operation_type === 'settle' || row.operation_type === 'abort_settle')
      .map((row) => row.amount ?? 0),
  ));

  const deductionCredits = Math.abs(sumInteger(
    creditTransactions
      .filter((row) => countsAsCreditSpend(row))
      .map((row) => row.amount ?? 0),
  ));

  const completedPaymentOrders = paymentOrders.filter((row) => row.status === 'completed');
  const purchaseCredits = sumInteger(
    creditTransactions
      .filter((row) => normalizeCreditLedgerType(row) === 'grant' && row.amount > 0)
      .map((row) => row.amount ?? 0),
  );

  const summary: BillingReconciliationSummary = {
    successfulAiRequests,
    tokenStatsCount,
    tokenStatsCredits,
    settledCredits,
    deductionCredits,
    completedPaymentOrders: completedPaymentOrders.length,
    completedPaymentAmount: sumInteger(completedPaymentOrders.map((row) => row.amount_total ?? 0)),
    purchaseCredits,
    webSearchCount,
  };

  const mismatches: string[] = [];
  if (successfulAiRequests !== tokenStatsCount) {
    mismatches.push(`AI success logs (${successfulAiRequests}) do not match token stats rows (${tokenStatsCount})`);
  }
  if (settledCredits !== tokenStatsCredits) {
    mismatches.push(`Billing settle credits (${settledCredits}) do not match token stats credits (${tokenStatsCredits})`);
  }
  if (deductionCredits < tokenStatsCredits) {
    mismatches.push(`Credit deductions (${deductionCredits}) are lower than token stats credits (${tokenStatsCredits})`);
  }
  if (completedPaymentOrders.length > 0 && purchaseCredits <= 0) {
    mismatches.push(`Completed payment orders (${completedPaymentOrders.length}) have no matching purchase credits`);
  }

  return {
    periodStart: start,
    periodEnd: end,
    success: mismatches.length === 0,
    mismatches,
    summary,
  };
}
