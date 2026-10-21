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
    // No 用户案例 link: the page is not built, and the fictional people are never called 用户案例 (Owner 2026-10-17).
    expect(html).not.toContain('用户案例');
    expect(html).not.toContain('href="/landing/samples"');
    expect(html).not.toMatch(/href="\/en/);
    // The refund policy page exists (src/app/(zh-hans)/refund), so it is no longer pending (review on #1088).
    expect(J_PENDING_PAGES).not.toContain('/refund');
  });
});

describe('style sample J, round seven: the takeover follows the real conversation (Owner 2026-10-15)', () => {
  it('runs 8, 7 and 6 lines, every required field filled by its step\'s summary, clicked answers equal to the options', async () => {
    const { J_TAKEOVER_MOMENTS } = await import('@/lib/landing/landing-copy-j-takeover');
    const { J_FIELDS, J_FIELD_VALUES, J_PERSONA_DIRECTION, J_PERSONA_GOAL, J_STEPS } = await import('@/lib/landing/landing-copy-j-persona');
    const steps = J_TAKEOVER_MOMENTS.slice(0, 3);
    expect(steps.map(step => step.lines.length)).toEqual([8, 7, 6]);
    steps.forEach((moment, index) => {
      const filled = new Set(moment.lines.flatMap(line => line.fills ?? []));
      // The real Skill declares every field required.
      for (const field of J_FIELDS[J_STEPS[index].id]) {
        expect(field.required).toBe(true);
        expect(filled.has(field.id)).toBe(true);
        expect(J_FIELD_VALUES[field.id]?.value.length).toBeGreaterThan(4);
      }
      // A step ends on its summary with the confirm area; no confirm area hangs under a question any more.
      expect(moment.lines[moment.lines.length - 1]).toMatchObject({ role: 'summary', card: 'confirm' });
      expect(moment.lines.filter(line => line.card === 'confirm')).toHaveLength(1);
    });
    // An option clicked is sent as the user's message, word for word (question-card.tsx).
    const know = steps[0].lines;
    const goalAt = know.findIndex(line => line.card === 'goal');
    expect(J_PERSONA_GOAL.options).toContain(know[goalAt + 1].text);
    const diagnose = steps[1].lines;
    const directionAt = diagnose.findIndex(line => line.card === 'direction');
    expect(J_PERSONA_DIRECTION.options).toContain(diagnose[directionAt + 1].text);
    // No @handle from the report's profile kit ("它" appears only for the account, in the Skill's own question).
    expect(JSON.stringify(J_TAKEOVER_MOMENTS)).not.toMatch(/@[A-Za-z0-9]/);
  });
});
