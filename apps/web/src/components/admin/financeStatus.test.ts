/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { activeLabel, activeState, collectFinanceUnknowns } from './financeStatus';

const labels = { on: '启用', off: '禁用' };

describe('finance active status', () => {
  it('accepts both the string and boolean forms of true and false', () => {
    expect(activeState('true')).toBe('on');
    expect(activeState(true)).toBe('on');
    expect(activeState('false')).toBe('off');
    expect(activeState(false)).toBe('off');
    expect(activeLabel(true, labels)).toBe('启用');
    expect(activeLabel(false, labels)).toBe('禁用');
  });

  it('shows an unrecognized value as-is with 未知状态 instead of the off label', () => {
    expect(activeState('archived')).toBe('unknown');
    expect(activeLabel('archived', labels)).toBe('archived（未知状态）');
    expect(activeLabel('TRUE', { on: '已上架', off: '已下架' })).toBe('TRUE（未知状态）');
  });
});

describe('collectFinanceUnknowns', () => {
  it('returns nothing when every type and status is known', () => {
    expect(collectFinanceUnknowns(undefined)).toEqual([]);
    expect(collectFinanceUnknowns({
      transactions: { unknownTypeCount: 0, unknownTypes: {} },
      packages: { unknownActiveCount: 0, packages: [{ active: 'true' }, { active: 'false' }] },
      runtimeBilling: { unknownModelActiveCount: 0 },
      modelStats: [{ isActive: true }, { isActive: 'false' }],
    })).toEqual([]);
  });

  it('lists each unknown category with its raw values and counts', () => {
    const items = collectFinanceUnknowns({
      transactions: { unknownTypeCount: 3, unknownTypes: { bonus: 2, promo: 1 } },
      packages: { unknownActiveCount: 1, packages: [{ active: 'true' }, { active: 'paused' }] },
      runtimeBilling: { unknownModelActiveCount: 2 },
      modelStats: [{ isActive: true }, { isActive: 'beta' }, { isActive: 'beta' }],
    });
    expect(items).toEqual([
      { key: 'transactionType', title: '未知流水类型（未计入收支）', count: 3,
        values: [{ value: 'bonus', count: 2 }, { value: 'promo', count: 1 }] },
      { key: 'packageStatus', title: '未知积分包状态', count: 1, values: [{ value: 'paused', count: 1 }] },
      { key: 'modelStatus', title: '未知模型状态（不计入活跃模型）', count: 2, values: [{ value: 'beta', count: 2 }] },
    ]);
  });
});
