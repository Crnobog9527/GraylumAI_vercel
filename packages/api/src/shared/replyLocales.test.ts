/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replyLocale } from './replyLanguage';
import { DEFAULT_REPLY_LOCALE, effectiveReplyLocale, entryLocaleHint, isReplyLocale, REPLY_LOCALES } from './replyLocales';

const NOT_LOCALES = [undefined, null, '', 'zh', 'zh-hans', 'ZH-HANS', 'zh-Hans ', 'en-US', 'fr', 0, 1, true, {}, ['en'], { value: 'en' }];

describe('reply locales (the plain checks the browser loads on every page)', () => {
  it('accepts exactly the stored values', () => {
    for (const locale of REPLY_LOCALES) {
      expect(isReplyLocale(locale)).toBe(true);
      expect(effectiveReplyLocale(locale)).toBe(locale);
      expect(entryLocaleHint(locale)).toBe(locale);
    }
  });

  it('falls back to Simplified Chinese for a missing or unknown stored value, and to none for an unknown link hint', () => {
    for (const value of NOT_LOCALES) {
      expect(isReplyLocale(value)).toBe(false);
      expect(effectiveReplyLocale(value)).toBe(DEFAULT_REPLY_LOCALE);
      expect(entryLocaleHint(value as string | null | undefined)).toBeNull();
    }
  });

  it('decides the same as the zod schema the server validates inputs with', () => {
    for (const value of [...REPLY_LOCALES, ...NOT_LOCALES]) expect(isReplyLocale(value)).toBe(replyLocale.safeParse(value).success);
  });

  it('imports nothing, so it never brings a library into the JavaScript of every page', () => {
    const source = readFileSync(path.join(__dirname, 'replyLocales.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
