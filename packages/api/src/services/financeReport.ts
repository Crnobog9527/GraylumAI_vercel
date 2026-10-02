import { centsToPico, picoToUsd, sumUsdPico } from './reportUsd';

interface FinancePaymentOrder {
  amount_total: number | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
}

/**
 * Paid USD revenue minus recorded USD cost, summed exactly.
 * Only `completed` orders count: fully refunded and `partially_refunded` orders are excluded whole.
 */
export function buildFinanceUsdOverview(
  orders: FinancePaymentOrder[],
  tokenStats: { total_cost_usd: string | number | null }[],
) {
  const paidRevenueCents = orders.reduce((sum, order) => {
    if (order.status !== 'completed') return sum;
    if (order.payment_status !== 'paid' && order.payment_status !== 'no_payment_required') return sum;
    if (order.currency && order.currency.toLowerCase() !== 'usd') return sum;
    return sum + (order.amount_total ?? 0);
  }, 0);
  const recordedCostPico = sumUsdPico(tokenStats.map((stat) => stat.total_cost_usd));
  return {
    paidRevenueCents,
    recordedCostUsd: picoToUsd(recordedCostPico),
    estimatedProfitUsd: picoToUsd(centsToPico(paidRevenueCents) - recordedCostPico),
  };
}


const KNOWN_TRANSACTION_TYPES = new Set(['addition', 'purchase', 'checkin', 'deduction', 'consumption', 'adjustment', 'refund']);

/** Read-only projection: canonical token usage and billing refunds remain authoritative.
 * Unrecognized ledger types are visible but never guessed to be income or spending. */
export function buildFinanceTransactionStats(
  creditTransactions: { type: string; amount: number; created_at: string }[],
  tokenStats: { total_credits: number; created_at: string }[],
  billingHistory: { operation_type: string; amount: number; created_at: string }[],
  now: Date,
) {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const transactionStats = {
    totalAdditions: 0,
    totalCheckins: 0,
    unknownTypeCount: 0,
    unknownTypes: Object.create(null) as Record<string, number>,
    totalDeductions: 0,
    totalPurchases: 0,
    totalRefunds: 0,
    todayTransactions: 0,
    weekTransactions: 0,
    monthTransactions: 0,
  };

  // Daily breakdown for chart (last 30 days)
  const dailyStats: Record<string, { additions: number; checkins: number; deductions: number; purchases: number; unknownTypeCount: number }> = {};
  for (let i = 0; i < 30; i++) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateKey = date.toISOString().split('T')[0];
    dailyStats[dateKey] = { additions: 0, checkins: 0, deductions: 0, purchases: 0, unknownTypeCount: 0 };
  }

  creditTransactions.forEach(t => {
    const transDate = new Date(t.created_at);
    const dateKey = transDate.toISOString().split('T')[0];

    if (t.type === 'addition') {
      transactionStats.totalAdditions += t.amount;
      if (dailyStats[dateKey]) dailyStats[dateKey].additions += t.amount;
    } else if (t.type === 'checkin') {
      transactionStats.totalCheckins += t.amount;
      if (dailyStats[dateKey]) dailyStats[dateKey].checkins += t.amount;
    } else if (t.type === 'purchase') {
      transactionStats.totalPurchases += t.amount;
      if (dailyStats[dateKey]) dailyStats[dateKey].purchases += t.amount;
    } else if (!KNOWN_TRANSACTION_TYPES.has(t.type)) {
      transactionStats.unknownTypeCount++;
      transactionStats.unknownTypes[t.type] = (transactionStats.unknownTypes[t.type] ?? 0) + 1;
      if (dailyStats[dateKey]) dailyStats[dateKey].unknownTypeCount++;
    }

    if (transDate >= todayStart) transactionStats.todayTransactions++;
    if (transDate >= sevenDaysAgo) transactionStats.weekTransactions++;
    if (transDate >= thirtyDaysAgo) transactionStats.monthTransactions++;
  });

  tokenStats.forEach((stat) => {
    const createdAt = new Date(stat.created_at);
    const dateKey = createdAt.toISOString().split('T')[0];
    const credits = stat.total_credits;

    transactionStats.totalDeductions += credits;
    if (dailyStats[dateKey]) {
      dailyStats[dateKey].deductions += credits;
    }
  });

  billingHistory.forEach((entry) => {
    const createdAt = new Date(entry.created_at);
    if (createdAt >= todayStart) transactionStats.todayTransactions++;
    if (createdAt >= sevenDaysAgo) transactionStats.weekTransactions++;
    if (createdAt >= thirtyDaysAgo) transactionStats.monthTransactions++;

    if (entry.operation_type === 'refund') {
      transactionStats.totalRefunds += Math.abs(entry.amount);
    }
  });
  return { transactionStats, dailyStats };
}
