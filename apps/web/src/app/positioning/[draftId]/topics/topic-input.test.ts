/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { readPutBack, withoutPutBack } from './topic-input';

it('takes back only the copy the page put back: alone, or in front of a newer draft', () => {
  expect(withoutPutBack('选题消息', '选题消息')).toBe('');
  expect(withoutPutBack('选题消息\n\n新的草稿', '选题消息')).toBe('新的草稿');
  expect(withoutPutBack('新的草稿', '选题消息')).toBe('新的草稿');
});

it('reads the put-back request ids saved beside the draft, ignoring anything malformed', () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  expect([...readPutBack(storage('["r1","r2"]'), 'k')]).toEqual(['r1', 'r2']);
  expect([...readPutBack(storage('[1,"r3"]'), 'k')]).toEqual(['r3']);
  expect(readPutBack(storage('not json'), 'k').size).toBe(0);
  expect(readPutBack(storage(null), 'k').size).toBe(0);
});
