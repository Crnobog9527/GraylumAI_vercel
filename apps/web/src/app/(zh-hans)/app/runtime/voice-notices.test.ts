/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { voiceRevisedNotice } from './voice-notices';

describe('voice notices (VOICE-2 PR-3)', () => {
  it('says how many copied sentences were rewritten, in the words the plan gave', () => {
    expect(voiceRevisedNotice(2)).toBe('有 2 句和你的旧稿太像，已经换了说法。');
  });
});
