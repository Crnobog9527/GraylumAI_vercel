/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { SIGNUP_HREFS } from './site-chrome';

describe('public header sign-up link (CHAT-LANGUAGE)', () => {
  it('carries the Traditional Chinese entry language only on Traditional Chinese pages', () => {
    const lang = (href: string) => new URL(href, 'https://example.test').searchParams.get('lang');
    expect(lang(SIGNUP_HREFS['zh-TW'])).toBe('zh-Hant');
    expect(lang(SIGNUP_HREFS['zh-Hans'])).toBeNull();
    for (const href of Object.values(SIGNUP_HREFS)) expect(new URL(href, 'https://example.test').pathname).toBe('/login');
  });
});
