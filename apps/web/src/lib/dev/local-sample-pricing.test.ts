import { describe, expect, it } from 'vitest';
import { LOCAL_SAMPLE_OFFERS, LOCAL_SAMPLE_PLANS, withLocalSamplePricing } from './local-sample-pricing';

const real = [{ ...LOCAL_SAMPLE_PLANS[0], id: 'real-pro' }];

describe('local sample prices (local preview only)', () => {
  it('never apply outside a development server', () => {
    for (const NODE_ENV of ['production', 'test', undefined]) {
      expect(withLocalSamplePricing({ NODE_ENV }, [], {})).toEqual({ plans: [], offers: {}, sample: false });
    }
  });

  it('never replace real plan data, even in development', () => {
    expect(withLocalSamplePricing({ NODE_ENV: 'development' }, real, {})).toEqual({ plans: real, offers: {}, sample: false });
  });

  it('fill in the paywall final prices when a development server has no data', () => {
    const result = withLocalSamplePricing({ NODE_ENV: 'development' }, [], {});
    expect(result.sample).toBe(true);
    expect(result.plans.map(plan => [plan.level, plan.price.monthly, plan.price.yearly])).toEqual([['pro', 29, 279], ['gold', 69, 621]]);
    expect(LOCAL_SAMPLE_OFFERS.goldFirstMonth).toBe(49);
    expect(LOCAL_SAMPLE_OFFERS.founder?.price).toBe(496);
  });
});
