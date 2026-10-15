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

  it('the header is the Owner\'s: 产品 menu, 教程 (the blog), 价格, 常见问题, 关于我们, languages, 登录, 免费试用', () => {
    const html = renderToStaticMarkup(createElement(SiteHeaderJ, { siteName: 'Graylum' }));
    expect(html).toContain(J_NAV.product.label);
    for (const link of [...J_NAV.product.links, ...J_NAV.places]) expect(html).toContain(`href="${link.href}"`);
    expect(J_NAV.places.map(link => link.label)).toEqual(['教程', '价格', '常见问题', '关于我们']);
    expect(J_NAV.places[0].href).toBe('/blog');
    expect(html).not.toContain('样例报告');
    expect(html).not.toContain('href="/tutorials"');
    expect(html).toContain('>免费试用<');
    // One globe button with the current language; the menu lists the full names, the current one checked.
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-label="语言：简体中文"/);
    expect(html).toContain('href="/zh-tw"');
    expect(html).toMatch(/aria-checked="true"[^>]*><span>简体中文<\/span>/);
    // English shows as coming, with no link and no hreflang to /en (SEO_GEO_SPEC).
    expect(html).toContain('English');
    expect(html).toContain('即将推出');
    expect(html).not.toMatch(/href="\/en/);
    expect(html).not.toMatch(/hrefLang="en"|hreflang="en"/i);
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
    expect(html).toContain('用户案例');
    expect(html).toContain('href="/landing/samples"');
    expect(html).not.toMatch(/href="\/en/);
    expect(J_PENDING_PAGES).toContain('/refund');
  });
});
