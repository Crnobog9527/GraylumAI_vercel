import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PaywallPlanSource } from '@/components/paywall/paywallPlans';
import { pricingSentence, withPricing } from './feature-pricing';
import { FEATURES, FEATURES_HUB } from './features';
import { SIGNUP_GRANT_CREDITS } from './shared';

const plan = (level: string, monthly: number): PaywallPlanSource => ({
  id: level, name: level, level, price: { monthly, yearly: monthly * 10 }, credits: { monthly: 100, monthlyBonus: 0 },
  discount: 1, checkoutReady: { monthly: true, yearly: true },
});

describe('feature page pricing sentence', () => {
  it('reads Pro and Gold prices from the plans and never types a price into the page text', () => {
    const plans = [plan('pro', 31), plan('gold', 72.5)];
    expect(pricingSentence('positioning', plans)).toBe(`免费开始，注册送 ${SIGNUP_GRANT_CREDITS} 积分；会员 Pro 每月 $31 起，Gold 每月 $72.50。`);
    expect(pricingSentence('jury', plans)).toBe(`免费开始，注册送 ${SIGNUP_GRANT_CREDITS} 积分；评审团是 Gold 会员功能，每月 $72.50。`);
    expect(pricingSentence('hub', [plan('pro', 31)])).toContain('Pro 每月 $31 起');
    // The source file holds no dollar amount: any price comes from the catalog.
    expect(readFileSync(new URL('./features.ts', import.meta.url), 'utf8')).not.toMatch(/\$\s?\d/);
  });

  it('sends the reader to the pricing page when the catalog cannot be read', () => {
    expect(pricingSentence('content', [])).toBe(`免费开始，注册送 ${SIGNUP_GRANT_CREDITS} 积分；会员价格见价格页。`);
    expect(pricingSentence('jury', [])).toContain('价格见价格页');
  });

  it('adds the sentence to the definition of every feature page and the overview', () => {
    for (const content of [FEATURES_HUB, ...FEATURES.map(entry => entry.content)]) {
      expect(content.definition, content.path).toBeDefined();
      const slug = FEATURES.find(entry => entry.content === content)?.slug ?? 'hub';
      expect(withPricing(content, slug, [plan('pro', 29), plan('gold', 69)]).definition?.text, content.path).toContain('免费开始');
    }
  });
});
