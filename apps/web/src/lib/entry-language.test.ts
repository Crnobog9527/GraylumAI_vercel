/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEntryLanguage, ENTRY_LANGUAGE_TTL_MS, entryLanguageNotice, pendingEntryLanguage, rememberEntryLanguage } from './entry-language';
import { SIGNUP_CTA_HREF, SIGNUP_CTA_HREF_ZH_TW } from './seo/content/shared';

function stubStorage() {
  const items = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); } } });
  return items;
}
const langOf = (href: string) => new URL(href, 'https://example.test').searchParams.get('lang');
afterEach(() => vi.unstubAllGlobals());

describe('public page entry language (CHAT-LANGUAGE, Owner 2026-10-25)', () => {
  it('keeps the language of the page the login link came from, Simplified included, until applied', () => {
    stubStorage();
    rememberEntryLanguage(langOf(SIGNUP_CTA_HREF_ZH_TW), 1000);
    expect(pendingEntryLanguage(2000)).toBe('zh-Hant');
    rememberEntryLanguage(langOf(SIGNUP_CTA_HREF), 3000);
    expect(pendingEntryLanguage(4000)).toBe('zh-Hans');
    rememberEntryLanguage('en', 5000);
    expect(pendingEntryLanguage(6000)).toBe('en');
    clearEntryLanguage();
    expect(pendingEntryLanguage(7000)).toBeNull();
  });

  it('opening the login page without a language (not from a public page) forgets an earlier one', () => {
    const items = stubStorage();
    rememberEntryLanguage('zh-Hant', 1000);
    for (const value of [null, '', 'fr']) {
      rememberEntryLanguage('zh-Hant', 1000);
      rememberEntryLanguage(value, 2000);
      expect(items.size).toBe(0);
      expect(pendingEntryLanguage(3000)).toBeNull();
    }
  });

  it('lapses after two hours, so an abandoned visit never changes a later sign-in', () => {
    stubStorage();
    rememberEntryLanguage('en', 0);
    expect(pendingEntryLanguage(ENTRY_LANGUAGE_TTL_MS - 1)).toBe('en');
    expect(pendingEntryLanguage(ENTRY_LANGUAGE_TTL_MS)).toBeNull();
    expect(pendingEntryLanguage(-1)).toBeNull();
  });

  it('ignores a malformed stored value, and blocked storage just drops the hint', () => {
    const items = stubStorage();
    for (const raw of ['zh-Hant', '{"language":"fr","at":1}', '{"language":"en"}', 'not json']) {
      items.set('graylum.entry-language', raw);
      expect(pendingEntryLanguage(2)).toBeNull();
    }
    vi.stubGlobal('window', { get localStorage(): Storage { throw new Error('blocked'); } });
    expect(() => rememberEntryLanguage('zh-Hant')).not.toThrow();
    expect(pendingEntryLanguage()).toBeNull();
  });

  it('says which language AI replies now use, and what it replaced', () => {
    expect(entryLanguageNotice({ language: 'zh-Hant', previous: 'zh-Hans' })).toEqual({ title: 'AI 回复语言：繁體中文',
      description: '已按你进入的页面，从简体中文改为繁體中文。可在右上角「语言」修改。' });
    expect(entryLanguageNotice({ language: 'en', previous: 'en' })).toEqual({ title: 'AI 回复语言：English',
      description: '按你进入的页面设置。可在右上角「语言」修改。' });
  });
});
