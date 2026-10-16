import { describe, expect, it } from 'vitest';
import { formatUsd, getCreditPackagePrice } from './creditPackagePrice';

const plans = [{ level: 'pro', discount: 0.1 }, { level: 'gold', discount: 0.2 }];

describe('credit pack price', () => {
  it('charges a member their level discount, as checkout does', () => {
    expect(getCreditPackagePrice(1, 'pro', plans)).toEqual({ payableUsd: 0.9, listUsd: 1, discounted: true });
    expect(getCreditPackagePrice(9.9, 'gold', plans)).toEqual({ payableUsd: 7.9, listUsd: 9.9, discounted: true });
  });

  it('rounds down to the dime exactly as card checkout charges (0222)', () => {
    // The live packs: Pro 9.5 折, Gold 9 折 of $9.90 / $29.90 / $99.90.
    const live = [{ level: 'pro', discount: 0.05 }, { level: 'gold', discount: 0.1 }];
    expect([9.9, 29.9, 99.9].map(price => getCreditPackagePrice(price, 'pro', live).payableUsd)).toEqual([9.4, 28.4, 94.9]);
    expect([9.9, 29.9, 99.9].map(price => getCreditPackagePrice(price, 'gold', live).payableUsd)).toEqual([8.9, 26.9, 89.9]);
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
