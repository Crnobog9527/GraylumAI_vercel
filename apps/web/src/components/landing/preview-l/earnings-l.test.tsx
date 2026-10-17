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
    expect(earningCount(0.5)).toBe('0–1');
    expect(earningCount(1000)).toBe('1,000');
    expect(earningTotal(1000)).toBe('约 $1,000');
  });

  it('shows the 1 万 tier first, each step with its share in brackets, and says it is an example; no jargon', () => {
    const html = renderToStaticMarkup(<EarningsL />);
    expect(html).toContain(E.title);
    expect(html).toContain('aria-checked="true">1 万</button>');
    for (const text of ['10,000 人', '20 人', '（0.2%）', '4 单', '（0.04%）', '（5%）', '0–1 本', '（50%）', '约 $20', E.disclaimer]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('（—）');
    for (const word of ['转化率', '漏斗', '层']) expect(html).not.toContain(word);
  });
});
