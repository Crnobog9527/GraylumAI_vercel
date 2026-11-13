/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { minutesFileName, minutesNotice } from './session-minutes';

it('says each refusal in plain words and never shows a code', () => {
  expect(minutesNotice('MINUTES_EMPTY')).toContain('还没有内容');
  expect(minutesNotice('TURN_SESSION_BUSY')).toContain('正在回复');
  expect(minutesNotice('LOST')).toContain('不会重复扣费');
  expect(minutesNotice('SOMETHING_NEW')).not.toMatch(/[A-Z_]{4,}/);
});

it('names an exported file by its local time', () => {
  const name = minutesFileName(new Date(2026, 10, 14, 9, 5).toISOString());
  expect(name).toBe('纪要-2026-11-14-0905.md');
});
