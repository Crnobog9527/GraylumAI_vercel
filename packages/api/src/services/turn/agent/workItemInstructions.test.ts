/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { WORK_ITEM_INSTRUCTIONS } from './workItemInstructions';

// Staging evaluation of #2012: follow-ups on another topic still said "我前面已经提醒过一次"; "整理本选题" in the chat did not start minutes.
it('answers a follow-up on another topic without restating the reminder, and treats 整理本选题 as a minutes request', () => {
  expect(WORK_ITEM_INSTRUCTIONS).toContain('the first sentence of your reply is the answer');
  expect(WORK_ITEM_INSTRUCTIONS).toContain('do not say the reminder was already given');
  expect(WORK_ITEM_INSTRUCTIONS).toContain('call request_minutes');
});
