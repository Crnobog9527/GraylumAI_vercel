import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import PricingSection from './PricingSection';

const plan = {
  id: 'plan-pro',
  name: 'Pro',
  level: 'pro',
  price: { monthly: 12.5, yearly: 120 },
  credits: { monthly: 1000, monthlyBonus: 100, yearly: 12000, yearlyBonus: 1200 },
  features: ['API plan feature'],
  checkoutReady: { monthly: true, yearly: true },
};

const localChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function renderPricing(status: 'available' | 'empty' | 'unavailable', plans = [plan]) {
  return renderToStaticMarkup(createElement(PricingSection, { status, plans }));
}

describe('PricingSection catalog availability', () => {
  it('renders only API-backed prices and a subscription CTA for an available catalog', () => {
    const markup = renderPricing('available');

    expect(markup).toContain('Pro');
    expect(markup).toContain('$12.50');
    expect(markup).toContain('$120.00');
    expect(markup).toContain('API plan feature');
    expect(markup).toContain('立即订阅');
    expect(markup).not.toContain('$99.00');
    expect(markup).not.toContain('$299.00');
  });

  it('renders a successful empty state without prices or checkout CTA', () => {
    const markup = renderPricing('empty', []);

    expect(markup).toContain('当前暂无可用套餐');
    expect(markup).toContain('data-testid="public-pricing-empty"');
    expect(markup).not.toContain('尚未发布');
    expect(markup).not.toContain('立即订阅');
    expect(markup).not.toContain('$99');
    expect(markup).not.toContain('$299');
  });

  it('renders a retryable unavailable state without prices or checkout CTA', () => {
    const markup = renderPricing('unavailable', []);

    expect(markup).toContain('套餐服务暂不可用');
    expect(markup).toContain('重新加载');
    expect(markup).toContain('data-testid="public-pricing-unavailable"');
    expect(markup).not.toContain('尚未发布');
    expect(markup).not.toContain('立即订阅');
    expect(markup).not.toContain('$99');
    expect(markup).not.toContain('$299');
  });

  it('keeps a plan with missing Stripe Price configuration visible but non-checkout', () => {
    const markup = renderPricing('available', [{
      ...plan,
      checkoutReady: { monthly: false, yearly: false },
    }]);

    expect(markup).toContain('Pro');
    expect(markup).toContain('$12.50');
    expect(markup).toContain('联系我们');
    expect(markup).not.toContain('立即订阅');
    expect(markup).not.toContain('action=signup');
  });

  it.skipIf(!existsSync(localChromePath))(
    'keeps the unavailable state safe in a local mobile browser',
    async () => {
      const browser = await chromium.launch({
        executablePath: localChromePath,
        headless: true,
      });

      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.setContent(renderPricing('unavailable', []));

        await expect(page.getByTestId('public-pricing-unavailable').count()).resolves.toBe(1);
        await expect(page.getByRole('link', { name: '重新加载' }).count()).resolves.toBe(1);
        await expect(page.getByText('立即订阅', { exact: true }).count()).resolves.toBe(0);
        await expect(page.getByText(/尚未发布/).count()).resolves.toBe(0);
        await expect(page.getByText(/\$99(?:\.00)?/).count()).resolves.toBe(0);
        await expect(
          page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        ).resolves.toBe(false);
      } finally {
        await browser.close();
      }
    },
  );
});
