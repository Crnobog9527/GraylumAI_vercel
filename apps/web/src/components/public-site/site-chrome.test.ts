/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { LOGIN_HREF, LOGIN_HREFS, SIGNUP_HREFS } from './site-chrome';

describe('public header login and sign-up links (CHAT-LANGUAGE)', () => {
  it('carry the page language, so signing in from the page takes it', () => {
    const lang = (href: string) => new URL(href, 'https://example.test').searchParams.get('lang');
    expect([lang(SIGNUP_HREFS['zh-TW']), lang(LOGIN_HREFS['zh-TW'])]).toEqual(['zh-Hant', 'zh-Hant']);
    expect([lang(SIGNUP_HREFS['zh-Hans']), lang(LOGIN_HREFS['zh-Hans']), lang(LOGIN_HREF)]).toEqual(['zh-Hans', 'zh-Hans', 'zh-Hans']);
    for (const href of [...Object.values(SIGNUP_HREFS), ...Object.values(LOGIN_HREFS)])
      expect(new URL(href, 'https://example.test').pathname).toBe('/login');
  });
});
