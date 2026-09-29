import { describe, expect, it } from 'vitest';
import { buildCostOverviewFromRows, buildCostTrendFromRows, buildModelDistributionFromRows,
  buildTopUsersFromRows } from './costReport';
import { buildFinanceUsdOverview } from './financeReport';
import { buildPerformanceCostStats } from './performanceCostReport';
import { centsToPico, divRoundPico, picoToUsd, sumUsdPico, usdToPico } from './reportUsd';

const MANY = 3000;
const EXACT_TOTAL = 13110; // 3000 × 4.37, computed in decimal

function floatSum(count: number, value: string) {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += Number(value);
  return sum;
}

describe('usdToPico', () => {
  it.each([
    ['4.37', 4_370_000_000_000n],
    ['4.370000', 4_370_000_000_000n],
    [4.37, 4_370_000_000_000n],
    ['0.000001', 1_000_000n],
    [1e-7, 100_000n],
    ['-0.0005', -500_000_000n],
    ['.5', 500_000_000_000n],
    ['12', 12_000_000_000_000n],
    [null, 0n],
    [undefined, 0n],
  ])('parses %s exactly', (value, expected) => {
    expect(usdToPico(value)).toBe(expected);
  });

  it('rounds digits beyond one picodollar half away from zero', () => {
    expect(usdToPico('0.0000000000005')).toBe(1n);
    expect(usdToPico('-0.0000000000005')).toBe(-1n);
    expect(usdToPico('0.0000000000004')).toBe(0n);
  });

  it.each(['', 'abc', '1.2.3', '-', 'NaN', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid recorded amount %s',
    (value) => {
      expect(() => usdToPico(value as string | number)).toThrow('Invalid recorded USD amount');
    },
  );
});

describe('exact report arithmetic', () => {
  it('shows why float accumulation is not used', () => {
    expect(floatSum(MANY, '4.37')).not.toBe(EXACT_TOTAL);
  });

  it('sums many small amounts to the exact decimal total', () => {
    const total = sumUsdPico(Array.from({ length: MANY }, () => '4.37'));
    expect(total).toBe(13_110_000_000_000_000n);
    expect(picoToUsd(total)).toBe(EXACT_TOTAL);
    expect(picoToUsd(sumUsdPico(Array.from({ length: 10 }, () => 0.1)))).toBe(1);
  });

  it('converts cents and rounds divisions half away from zero', () => {
    expect(centsToPico(1500)).toBe(15_000_000_000_000n);
    expect(divRoundPico(5n, 2n)).toBe(3n);
    expect(divRoundPico(-5n, 2n)).toBe(-3n);
    expect(divRoundPico(4n, 3n)).toBe(1n);
    expect(() => divRoundPico(1n, 0n)).toThrow();
    expect(picoToUsd(-500_000_000n)).toBe(-0.0005);
    expect(picoToUsd(0n)).toBe(0);
  });
});

describe('report totals use exact accumulation', () => {
  const rows = Array.from({ length: MANY }, (_, i) => ({
    user_id: 'user-1', model_used: 'model-a', total_credits: 1,
    total_cost_usd: i % 2 ? '4.37' : '4.370000',
    created_at: '2026-03-29T08:00:00.000Z',
  }));

  it('cost overview, trend, distribution and top users', () => {
    const overview = buildCostOverviewFromRows(rows, '2026-03-29T00:00:00.000Z', 'usd');
    expect(overview).toMatchObject({ todayUsd: EXACT_TOTAL, monthUsd: EXACT_TOTAL,
      todayCost: EXACT_TOTAL, monthCost: EXACT_TOTAL, avgCostPerCall: 4.37 });
    const trend = buildCostTrendFromRows(rows, 1, 'usd', new Date('2026-03-29T12:00:00.000Z'), 'UTC');
    expect(trend[0]).toMatchObject({ usd: EXACT_TOTAL, cost: EXACT_TOTAL });
    expect(buildModelDistributionFromRows(rows, 'usd')[0]).toMatchObject({
      usd: EXACT_TOTAL, cost: EXACT_TOTAL, percentage: 100 });
    expect(buildTopUsersFromRows(rows, [], 'usd', 10)[0]).toMatchObject({
      totalUsd: EXACT_TOTAL, totalCost: EXACT_TOTAL });
  });

  it('performance totals and monthly estimate', () => {
    expect(buildPerformanceCostStats(rows, 7, 0)).toMatchObject({
      totalCost: EXACT_TOTAL, avgCostPerRequest: 4.37, estimatedMonthly: 56185.714285714286 });
  });

  it('finance recorded cost and estimated profit', () => {
    expect(buildFinanceUsdOverview([
      { amount_total: 2_000_000, currency: 'usd', status: 'completed', payment_status: 'paid' },
    ], rows)).toEqual({ paidRevenueCents: 2_000_000, recordedCostUsd: EXACT_TOTAL,
      estimatedProfitUsd: 6890 });
  });
});

describe('finance revenue refund scope', () => {
  it('excludes refunded and partially refunded orders whole', () => {
    const order = { amount_total: 1000, currency: 'USD', payment_status: 'paid' };
    expect(buildFinanceUsdOverview([
      { ...order, status: 'completed' },
      { ...order, status: 'refunded' },
      { ...order, status: 'partially_refunded' },
      { ...order, status: 'completed', payment_status: 'unpaid' },
    ], [{ total_cost_usd: '0.1' }, { total_cost_usd: 0.2 }])).toEqual({
      paidRevenueCents: 1000, recordedCostUsd: 0.3, estimatedProfitUsd: 9.7 });
  });
});
