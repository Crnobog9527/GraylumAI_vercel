/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DollarSign } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { CostStatCard } from './CostStatCard';
import { ReportUsdValue } from './ReportUsdValue';

describe('ReportUsdValue', () => {
  it('shows a compact headline and keeps the exact amount visible below it', () => {
    const html = renderToStaticMarkup(createElement(ReportUsdValue, { amount: -0.0406667806, testId: 'profit' }));
    expect(html).toContain('title="-$0.0406667806"');
    expect(html).toContain('data-testid="profit">≈ -$0.04067</p>');
    expect(html).toContain('data-testid="profit-exact">-$0.0406667806</p>');
  });

  it('shows a single exact value when nothing was shortened', () => {
    const html = renderToStaticMarkup(createElement(ReportUsdValue, { amount: 12.5, testId: 'total' }));
    expect(html).toContain('>$12.50</p>');
    expect(html).not.toContain('≈');
    expect(html).not.toContain('title=');
    expect(html).not.toContain('total-exact');
  });
});

describe('CostStatCard', () => {
  it('renders USD amounts compactly and lets the text column shrink beside the icon', () => {
    const html = renderToStaticMarkup(createElement(CostStatCard, {
      title: '今日成本', value: 'unused', usdAmount: 0.001626671224, icon: DollarSign,
    }));
    expect(html).toContain('≈ $0.001627');
    expect(html).toContain('>$0.001626671224</p>');
    expect(html).not.toContain('unused');
    expect(html).toContain('class="min-w-0"');
    expect(html).toContain('shrink-0 p-3 rounded-xl');
  });

  it('renders non-USD values unchanged', () => {
    const html = renderToStaticMarkup(createElement(CostStatCard, {
      title: '今日消耗', value: '1,234 积分', subValue: '3 次调用 · $0.0001', icon: DollarSign, trend: 'up',
    }));
    expect(html).toContain('>1,234 积分</p>');
    expect(html).toContain('3 次调用 · $0.0001');
    expect(html).toContain('bg-emerald-500/20');
    expect(html).not.toContain('≈');
  });
});
