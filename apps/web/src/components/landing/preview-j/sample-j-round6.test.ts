import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PRICE_COMPARE } from '@/lib/landing/landing-copy';
import { J_FOOTER, J_NAV, J_PENDING_PAGES } from '@/lib/landing/landing-copy-j-chrome';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { ONE_LINE_DEFINITION } from '@/lib/seo/site';
import { PriceJ } from './PriceJ';
import { SiteFooterJ } from './SiteFooterJ';
import { SiteHeaderJ } from './SiteHeaderJ';
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

  it('the header carries the planned places, the language switch, 登录 and the button, without headings', () => {
    const html = renderToStaticMarkup(createElement(SiteHeaderJ, { siteName: 'Graylum' }));
    for (const label of [J_NAV.product.label, J_NAV.samples.label, J_NAV.pricing.label, J_NAV.resources.label, J_NAV.about.label]) {
      expect(html).toContain(label);
    }
    for (const link of [...J_NAV.product.links, ...J_NAV.resources.links]) expect(html).toContain(`href="${link.href}"`);
    expect(html).toContain('简体');
    expect(html).toContain('繁體');
    expect(html).toContain('免费和教练聊聊');
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('the footer has the four columns, the one-line definition and the copyright, without headings or social links', () => {
    const html = renderToStaticMarkup(createElement(SiteFooterJ));
    for (const column of J_FOOTER.columns) {
      expect(html).toContain(`<p>${column.title}</p>`);
      for (const link of column.links) expect(html).toContain(`href="${link.href}"`);
    }
    expect(html).toContain(ONE_LINE_DEFINITION['zh-Hans']);
    expect(html).toContain('© 2026 Grayscale Luminary LLC');
    expect(html).not.toMatch(/<h[1-6]/);
    expect(J_PENDING_PAGES).toContain('/refund');
  });
});
