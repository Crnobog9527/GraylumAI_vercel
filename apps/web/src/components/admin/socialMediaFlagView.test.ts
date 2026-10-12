/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { isSocialMediaFlagConflict, socialMediaFlagErrorText, socialMediaFlagSavedText } from './socialMediaFlagView';

it('maps every stable code to plain text and unknown errors to the generic text', () => {
  expect(socialMediaFlagErrorText(new Error('SOCIAL_MEDIA_FLAG_CONFLICT'))).toContain('重新读取');
  expect(socialMediaFlagErrorText(new Error('SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND'))).toContain('刷新');
  expect(socialMediaFlagErrorText(new Error('SOCIAL_MEDIA_FLAG_POSITIONING_SKILL'))).toContain('不能勾选');
  expect(socialMediaFlagErrorText(new Error('raw server text')))
    .toBe(socialMediaFlagErrorText(new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE')));
  expect(socialMediaFlagErrorText(new Error('toString'))).not.toContain('function');
  expect(socialMediaFlagErrorText(null)).toBe(socialMediaFlagErrorText(new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE')));
  expect(isSocialMediaFlagConflict(new Error('SOCIAL_MEDIA_FLAG_CONFLICT'))).toBe(true);
  expect(isSocialMediaFlagConflict(new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE'))).toBe(false);
});

it('describes what the saved value means for users', () => {
  expect(socialMediaFlagSavedText(true)).toContain('导入已有定位');
  expect(socialMediaFlagSavedText(false)).toContain('不再要求');
});
