/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { asksForMinutes, chatMinutesRequestId, minutesFileName, minutesNotice } from './session-minutes';

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

// CONTENT-CONVERSATION-2 PR3b: a reply that asked for the minutes, and the one request the page sends for it.
it('reads the minutes step of a reply and derives one request id per turn', () => {
  expect(asksForMinutes([{ tool: 'load_skill', label: '视频口播稿' }, { tool: 'other', label: '整理纪要' }])).toBe(true);
  expect(asksForMinutes([{ tool: 'other' }, { tool: 'load_skill', label: '整理纪要' }])).toBe(false);
  expect(asksForMinutes(null)).toBe(false);
  const id = chatMinutesRequestId(6716);
  expect(id).toBe(chatMinutesRequestId(6716));
  expect(id).not.toBe(chatMinutesRequestId(6717));
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

