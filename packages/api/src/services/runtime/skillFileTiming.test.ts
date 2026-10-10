/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it} from 'vitest';
import {createRequestTiming} from './timing';

it('separates file-reading turns and their first post-read text from ordinary turns', () => {
  let clock = 100;
  const timing = createRequestTiming(() => clock);
  clock = 150;
  timing.mark('firstModelText');
  clock = 200;
  timing.tagSkillFileRead();
  clock = 240;
  timing.mark('firstModelText');
  clock = 250;
  timing.mark('firstPublicText');
  clock = 290;
  timing.tagSkillFileRead();
  timing.mark('firstModelText');
  const summary = timing.summary();
  expect(summary.skillFileRead).toBe(true);
  expect(summary.marks.firstModelTextMs).toBe(50);
  expect(summary.afterSkillFileMarks).toEqual({firstModelTextMs: 140, firstPublicTextMs: 150});
  expect(createRequestTiming().summary()).not.toHaveProperty('skillFileRead');
});
