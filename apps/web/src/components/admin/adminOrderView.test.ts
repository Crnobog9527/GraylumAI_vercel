/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adminOrdersPageCount, adminOrdersPageInput, getBillingCycleLabel, getPaymentStatusLabel } from './adminOrderView';

describe('admin order paging', () => {
  it('never asks for more than 50 orders', () => {
    expect(adminOrdersPageInput(0)).toEqual({ offset: 0, limit: 20 });
    expect(adminOrdersPageInput(2)).toEqual({ offset: 40, limit: 20 });
    expect(adminOrdersPageInput(1, 500)).toEqual({ offset: 50, limit: 50 });
    expect(adminOrdersPageInput(-3)).toEqual({ offset: 0, limit: 20 });
  });

  it('counts pages', () => {
    expect(adminOrdersPageCount(0)).toBe(1);
    expect(adminOrdersPageCount(20)).toBe(1);
    expect(adminOrdersPageCount(21)).toBe(2);
  });

  it('labels unknown values without inventing a state', () => {
    expect(getBillingCycleLabel(null)).toBe('—');
    expect(getPaymentStatusLabel(null)).toBe('未知');
    expect(getPaymentStatusLabel('paid')).toBe('已付款');
  });
});
