/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { storable, storableText } from './storableText';

const LONE_HIGH = '\ud83d', LONE_LOW = '\ude00';

describe('storableText', () => {
  it('drops NUL and replaces a lone surrogate, and leaves ordinary text (emoji included) alone', () => {
    expect(storableText('a\0b\0')).toBe('ab');
    expect(storableText(`半个${LONE_HIGH}表情`)).toBe('半个�表情');
    expect(storableText(`${LONE_LOW}开头`)).toBe('�开头');
    const fine = '你好 😀 مرحبا\n\t"quoted"';
    expect(storableText(fine)).toBe(fine);
  });

  it('gives PostgreSQL text it accepts: what is left is well formed and has no NUL', () => {
    const cleaned = storableText(`x\0${LONE_HIGH}y${LONE_LOW}\0`);
    expect(cleaned.includes('\0')).toBe(false);
    expect(cleaned.isWellFormed()).toBe(true);
    // jsonb refuses the escapes \u0000 and a lone \ud83d; neither is left in the JSON that is sent.
    expect(JSON.stringify(cleaned)).not.toMatch(/\\u0000|\\ud83d|\\ude00/i);
  });
});

describe('storable', () => {
  it('cleans every string of a JSON value, nested and in keys', () => {
    const value = { text: `a\0${LONE_HIGH}`, list: ['ok', { deep: '\0x' }], [`k\0`]: 1, n: 3, b: true, none: null };
    expect(storable(value)).toEqual({ text: 'a�', list: ['ok', { deep: 'x' }], k: 1, n: 3, b: true, none: null });
  });

  it('returns the same value when nothing had to change (no copy of a large body)', () => {
    const value = { messages: [{ role: 'user', content: '正常的消息 😀' }], images: ['data:image/jpeg;base64,AAAA'] };
    expect(storable(value)).toBe(value);
    expect(storable(value.messages)).toBe(value.messages);
  });

  it('leaves what is not plain JSON alone', () => {
    const date = new Date(0);
    expect(storable(date)).toBe(date);
    expect(storable(undefined)).toBe(undefined);
    expect(storable(12)).toBe(12);
  });
});
