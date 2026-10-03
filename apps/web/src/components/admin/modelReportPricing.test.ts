/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { capacityRows, capacitySyncChanges, priceCell, userPricePreview, type ModelCapacityView } from './modelReportPricing';
import { mismatchedPrice, readyPrice, refusedPrice, unreadPrice } from './modelPriceFixtures';

const capacity = (current: number | null, supplier: number | null): ModelCapacityView => ({
  route: 'example/fp8', fetchedAt: '2026-10-01T00:00:00.000Z',
  inputLimit: { supplier: 272000, current: 272000, matches: true },
  maxTokens: { supplier, current, matches: supplier === null ? null : supplier === current },
});

describe('priceCell', () => {
  it('shows 未读取 without any number when no snapshot was read', () => {
    for (const kind of ['prompt', 'completion', 'web_search'] as const) {
      expect(priceCell(unreadPrice, kind)).toEqual({ main: '未读取', details: [], known: false });
    }
  });

  it('shows the base price with its unit and the frozen price', () => {
    expect(priceCell(readyPrice, 'prompt')).toEqual({ main: '$1.25', details: ['美元 / 百万 token', '冻结用单价 $2.5'], known: true });
    expect(priceCell(readyPrice, 'completion').details).toContain('冻结用单价 $15');
    expect(priceCell(readyPrice, 'web_search')).toEqual({ main: '$0.01', details: ['美元 / 次'], known: true });
  });

  it('never substitutes zero for a missing or refused price', () => {
    expect(priceCell(refusedPrice, 'prompt').details[1]).toBe('冻结用单价：不可推导（价格里有本系统不认识的字段）');
    expect(priceCell(refusedPrice, 'web_search')).toEqual({ main: '目录未列出', details: [], known: false });
    expect(priceCell(mismatchedPrice, 'prompt')).toEqual({ main: '不可推导', details: ['价格属于别的模型 ID，请重新读取'], known: false });
    for (const price of [unreadPrice, refusedPrice, mismatchedPrice]) {
      expect(JSON.stringify(priceCell(price, 'web_search'))).not.toMatch(/\$0(?!\.)/);
    }
  });
});

describe('userPricePreview', () => {
  it('multiplies unit price by m and q', () => {
    expect(userPricePreview('2.5', '1.5', '100')).toBe('375');
    expect(userPricePreview('0.125', '2', '100')).toBe('25');
  });

  it('returns null when a factor is unknown', () => {
    expect(userPricePreview('2.5', null, '100')).toBeNull();
    expect(userPricePreview('2.5', '1.5', null)).toBeNull();
  });
});

describe('capacity rows', () => {
  it('marks a mismatch and spells out unknown supplier values', () => {
    const rows = capacityRows(capacity(4096, 128000));
    expect(rows[1]).toMatchObject({ label: '最大输出 Token', supplier: '128,000', current: '4,096', state: '不一致', mismatch: true });
    expect(capacityRows(capacity(4096, null))[1]).toMatchObject({ supplier: '供应商未提供', state: '无法比较', mismatch: false });
    expect(capacityRows({ ...capacity(4096, null), fetchedAt: null })[1].supplier).toBe('未读取');
    expect(capacityRows(capacity(null, null))[1].current).toBe('未设置');
  });

  it('lists only the fields an explicit read changed', () => {
    expect(capacitySyncChanges(capacity(4096, 128000), capacity(128000, 128000))).toEqual(['最大输出 Token：4,096 → 128,000']);
    expect(capacitySyncChanges(capacity(4096, null), capacity(4096, null))).toEqual([]);
  });
});
