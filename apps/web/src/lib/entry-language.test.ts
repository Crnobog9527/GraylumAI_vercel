/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEntryLanguage, pendingEntryLanguage, rememberEntryLanguage } from './entry-language';
import { SIGNUP_CTA_HREF_ZH_TW } from './seo/content/shared';

function stubStorage() {
  const items = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); } } });
  return items;
}
afterEach(() => vi.unstubAllGlobals());

describe('sign-up entry language (CHAT-LANGUAGE)', () => {
  it('the Traditional Chinese sign-up link carries zh-Hant, which is kept until applied and then cleared', () => {
    const items = stubStorage();
    rememberEntryLanguage(new URL(SIGNUP_CTA_HREF_ZH_TW, 'https://example.test').searchParams.get('lang'));
    expect(pendingEntryLanguage()).toBe('zh-Hant');
    expect([...items.values()]).toEqual(['zh-Hant']);
    clearEntryLanguage();
    expect(pendingEntryLanguage()).toBeNull();
  });

  it('keeps nothing for the default language, unknown values or no hint', () => {
    const items = stubStorage();
    for (const value of ['zh-Hans', 'fr', '', null]) rememberEntryLanguage(value);
    expect(items.size).toBe(0);
    items.set('graylum.entry-language', 'zh-Hans');
    expect(pendingEntryLanguage()).toBeNull();
  });

  it('blocked storage just drops the hint', () => {
    vi.stubGlobal('window', { get localStorage(): Storage { throw new Error('blocked'); } });
    expect(() => rememberEntryLanguage('zh-Hant')).not.toThrow();
    expect(pendingEntryLanguage()).toBeNull();
  });
});
