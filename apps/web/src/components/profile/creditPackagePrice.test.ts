import { describe, expect, it } from 'vitest';
import { formatUsd, getCreditPackagePrice } from './creditPackagePrice';

const plans = [{ level: 'pro', discount: 0.1 }, { level: 'gold', discount: 0.2 }];

describe('credit pack price', () => {
  it('charges a member their level discount, as checkout does', () => {
    expect(getCreditPackagePrice(1, 'pro', plans)).toEqual({ payableUsd: 0.9, listUsd: 1, discounted: true });
    expect(getCreditPackagePrice(9.9, 'gold', plans)).toEqual({ payableUsd: 7.92, listUsd: 9.9, discounted: true });
  });

  it('rounds half cents up like Postgres round(numeric)', () => {
    // 1.05 * 90% = 0.945 -> 0.95; 0.99 * 90% = 0.891 -> 0.89.
    expect(getCreditPackagePrice(1.05, 'pro', plans).payableUsd).toBe(0.95);
    expect(getCreditPackagePrice(0.99, 'pro', plans).payableUsd).toBe(0.89);
  });

  it('keeps the list price for free users and when the discount cannot be read unambiguously', () => {
    const list = { payableUsd: 1, listUsd: 1, discounted: false };
    expect(getCreditPackagePrice(1, 'free', plans)).toEqual(list);
    expect(getCreditPackagePrice(1, undefined, plans)).toEqual(list);
    expect(getCreditPackagePrice(1, 'pro', undefined)).toEqual(list);
    expect(getCreditPackagePrice(1, 'pro', [])).toEqual(list);
    expect(getCreditPackagePrice(1, 'pro', [{ level: 'pro', discount: 0 }])).toEqual(list);
    expect(getCreditPackagePrice(1, 'pro', [{ level: 'pro', discount: 0.1 }, { level: 'pro', discount: 0.2 }])).toEqual(list);
  });

  it('formats USD with cents', () => {
    expect(formatUsd(0.9)).toBe('$0.90');
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});
