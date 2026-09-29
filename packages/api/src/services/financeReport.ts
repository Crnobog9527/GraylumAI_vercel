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
