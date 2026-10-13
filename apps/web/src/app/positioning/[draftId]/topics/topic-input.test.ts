/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { withoutPutBack } from './topic-input';

it('takes back only the copy the page put back: alone, or in front of a newer draft', () => {
  expect(withoutPutBack('选题消息', '选题消息')).toBe('');
  expect(withoutPutBack('选题消息\n\n新的草稿', '选题消息')).toBe('新的草稿');
  expect(withoutPutBack('新的草稿', '选题消息')).toBe('新的草稿');
});
