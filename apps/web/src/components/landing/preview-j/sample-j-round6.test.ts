import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PRICE_COMPARE } from '@/lib/landing/landing-copy';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { PriceJ } from './PriceJ';
import { WeekJ } from './WeekJ';

describe('style sample J, round six (Owner 2026-10-15)', () => {
  it('the five module labels on the first screen are buttons', () => {
    const html = renderToStaticMarkup(createElement(WeekJ));
    expect(html).toContain(`aria-label="${J_WEEK.pickLabel}"`);
    for (const name of J_WEEK.stages) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>.*?${name}</button>`));
  });

  it('the price never carries a "sample data" tag', () => {
    const rows = PRICE_COMPARE.rows.map(row => ({ ...row }));
    const html = renderToStaticMarkup(createElement(PriceJ, { proMonthly: 29, rows }));
    expect(html).toContain('$29/月起');
    expect(html).not.toContain('本机示例数据');
  });
});
