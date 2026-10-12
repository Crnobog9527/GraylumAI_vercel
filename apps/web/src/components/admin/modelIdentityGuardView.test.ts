/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { formatChangeTime, modelIdentityGuardError, stateLabel } from './modelIdentityGuardView';

it('maps server error codes to fixed messages and never shows raw text', () => {
  expect(modelIdentityGuardError({ data: { code: 'CONFLICT' } }, 'save')).toContain('已被其他人修改');
  expect(modelIdentityGuardError({ data: { code: 'FORBIDDEN' } }, 'save')).toBe('当前账号无权修改这个设置。');
  expect(modelIdentityGuardError({ data: { code: 'SERVICE_UNAVAILABLE' } }, 'read')).toContain('暂时无法读取');
  expect(modelIdentityGuardError(undefined, 'save')).toBe('保存失败，请重新读取后再试。');
});

it('formats change time and tolerates missing or invalid values', () => {
  expect(formatChangeTime(null)).toBeNull();
  expect(formatChangeTime('not a date')).toBeNull();
  expect(formatChangeTime('2026-10-12T01:02:03.000000Z')).toMatch(/2026/);
});

it('labels the state', () => {
  expect(stateLabel(true)).toBe('已开启');
  expect(stateLabel(false)).toBe('已关闭');
});
