/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { summaryStat } from './summaryStat';

const pick = (data: { totalSpent: number }) => data.totalSpent;

describe('summaryStat', () => {
  it('formats a real value, including a real zero', () => {
    expect(summaryStat({ data: { totalSpent: 1234 } }, pick)).toBe((1234).toLocaleString());
    expect(summaryStat({ data: { totalSpent: 0 } }, pick)).toBe('0');
  });

  it('does not show 0 when the read failed or is pending', () => {
    expect(summaryStat({ isError: true }, pick)).toBe('读取失败');
    expect(summaryStat({}, pick)).toBe('…');
  });
});
