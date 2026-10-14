import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANDING_FAQ } from './landing-faq';
import { FLOW_STEPS } from './landing-flow';
import { buildLandingPricing } from './landing-pricing';

// The Owner's final copy as committed in docs; the page must quote it word for word.
const ONE_PAGE = readFileSync(
  path.resolve(__dirname, '../../../../../docs/launch/design/landing/offer-one-page-final-2026-10-13.md'), 'utf8');

function section(start: string, end: string) {
  return ONE_PAGE.split(start)[1].split(end)[0];
}

describe('landing copy matches the final offer', () => {
  it('quotes the nine walk-through steps and their notes verbatim', () => {
    const rows = section('| 步 | 动画演示', '[没验收').trim().split('\n').slice(2)
      .map(row => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
    expect(rows).toHaveLength(9);
    expect(FLOW_STEPS.map(step => [`${step.title}：${step.demo}`, step.note]))
      .toEqual(rows.map(([, demo, note]) => [demo, note]));
  });

  it('quotes all 16 FAQ questions and answers verbatim', () => {
    const faq = section('## 5. 常见问题', '## 6.');
    for (const item of LANDING_FAQ.flatMap(group => group.items)) {
      expect(faq).toContain(`**${item.question}**`);
      for (const paragraph of item.answer) expect(faq).toContain(paragraph);
    }
  });

  it('quotes the price cards\' result and "适合谁" lines verbatim (Pro | Gold | 创始会员)', () => {
    const plan = (level: string, monthly: number, yearly: number) => ({
      id: level, name: level, level, price: { monthly, yearly },
      credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
    });
    const { cards } = buildLandingPricing([plan('pro', 29, 279), plan('gold', 69, 621)],
      { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 10 } });
    const row = (label: string) => ONE_PAGE.split('\n').find(line => line.startsWith(`| ${label} |`))!
      .replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).slice(1);
    expect(cards.map(card => card.key)).toEqual(['pro', 'gold', 'founder']);
    expect(cards.map(card => card.result.text)).toEqual(row('第一行（结果）'));
    expect(cards.map(card => card.fit)).toEqual(row('适合谁'));
  });
});
