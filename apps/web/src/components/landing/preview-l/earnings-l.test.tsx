/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { earningCount, earningTotal, L_EARNINGS as E } from '@/lib/landing/landing-copy-l-earnings';
import { EarningsL } from './EarningsL';

describe('一个月能赚多少 (round seven, T6)', () => {
  it('adds up as the plan checks it: $1.5 an order, $5 a month, $19 a book', () => {
    E.totals.forEach((total, tier) => {
      const [, , orders, subscribers, books] = E.rows.map(row => row.counts[tier]);
      const sum = orders * 1.5 + subscribers * 5 + books * 19;
      expect(Math.abs(sum - total) / total).toBeLessThan(0.1);
    });
    // Round eight (U2): each share is of the step before; the formula's per-person sum, times the people who took
    // the menu, is the month.
    const [plays, menus, orders, subscribers, books] = E.rows.map(row => row.counts[1]);
    expect(menus / plays).toBeCloseTo(0.002, 5);
    expect(orders / menus).toBeCloseTo(0.2, 5);
    expect(subscribers / orders).toBeCloseTo(0.25, 5);
    expect(books / subscribers).toBeCloseTo(0.5, 5);
    E.formula.menus.forEach((count, tier) => {
      const month = Number(count.replace(/,/g, '')) * (0.2 * 1.5 + 0.2 * 0.25 * 5 + 0.2 * 0.25 * 0.5 * 19);
      expect(`$${Math.floor(month).toLocaleString('en-US')}`).toBe(E.formula.results[tier]);
    });
    expect(earningCount(0.5)).toBe('0–1');
    expect(earningCount(1000)).toBe('1,000');
    expect(earningTotal(1000)).toBe('约 $1,000');
  });

  it('shows the 1 万 tier first, each step with its share in brackets, and says it is an example; no jargon', () => {
    const html = renderToStaticMarkup(<EarningsL />);
    expect(html).toContain(E.title);
    expect(html).toContain('aria-checked="true">1 万</button>');
    for (const text of ['10,000 人', '20 人', '（0.2%）', '4 单', '（20%）', '（25%）', '0–1 本', '（50%）', '约 $20', E.disclaimer,
      E.formula.title, '= 10,000 × 0.2% ×', '= 20 ×', '≈ $20 / 月', E.layers.title, E.layers.close]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('（—）');
    expect(html).not.toContain('转化率');
    expect(html).not.toContain('钱 = 刷到你的人');
  });
});
