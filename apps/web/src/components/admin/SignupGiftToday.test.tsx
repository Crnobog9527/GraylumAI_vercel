/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
import { SignupGiftTodayLine } from './SignupGiftToday';

const line = (props: { granted: number; cap: number; paused: boolean }) =>
  renderToStaticMarkup(createElement(SignupGiftTodayLine, { day: '2026-11-13', ...props }));

describe('SignupGiftTodayLine', () => {
  it('shows today’s count against the cap, and says when nobody new is granted', () => {
    expect(line({ granted: 3, cap: 30, paused: false })).toContain('已送 3 / 上限 30');
    expect(line({ granted: 3, cap: 30, paused: false })).not.toContain('一律不送');
    expect(line({ granted: 3, cap: 30, paused: true })).toContain('注册赠送已暂停');
    expect(line({ granted: 0, cap: 0, paused: false })).toContain('上限为 0');
    expect(line({ granted: 0, cap: 0, paused: false })).toContain('不会补发');
  });
});
