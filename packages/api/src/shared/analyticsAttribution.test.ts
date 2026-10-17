/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { parseSignupAttribution, registeredUtm } from './analyticsAttribution';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const seen = '2026-10-10T08:00:00.000Z';

describe('parseSignupAttribution', () => {
  it('keeps registered UTM values, a host name, a route template and the first-visit time', () => {
    expect(parseSignupAttribution({ utm_source: 'YouTube', utm_medium: 'video', referrer_host: 'ChatGPT.com',
      landing_path: '/zh-tw/ig-jingying', first_seen_at: seen }, NOW)).toEqual({ utm_source: 'youtube', utm_medium: 'video',
      referrer_host: 'chatgpt.com', landing_path: '/zh-tw/ig-jingying', first_seen_at: seen });
    expect(parseSignupAttribution({ landing_path: '/positioning/[draftId]', first_seen_at: seen }, NOW))
      .toEqual({ landing_path: '/positioning/[draftId]', first_seen_at: seen });
  });

  it('drops unregistered values, personal data, full URLs, record IDs and unknown keys', () => {
    expect(parseSignupAttribution({ utm_source: 'someone@example.com', utm_campaign: 'Alice.Smith',
      referrer_host: 'https://chatgpt.com/c/123', landing_path: '/positioning/3f2a9c1e-0000-4000-8000-000000000001',
      email: 'a@b.c', ip: '1.2.3.4', first_seen_at: seen }, NOW)).toEqual({ first_seen_at: seen });
    for (const path of ['/verify-email?email=a@b.c', '/x/1234567', 'positioning', '/a b', `/${'a'.repeat(130)}`]) {
      expect(parseSignupAttribution({ landing_path: path, first_seen_at: seen }, NOW)).toEqual({ first_seen_at: seen });
    }
    expect(registeredUtm('?utm_source=reddit&utm_term=Bob')).toEqual([['utm_source', 'reddit']]);
  });

  it('refuses a record without a plausible first-visit time', () => {
    for (const first of [undefined, 'yesterday', '2027-01-01T00:00:00Z', '2025-01-01T00:00:00Z']) {
      expect(parseSignupAttribution({ utm_source: 'youtube', first_seen_at: first }, NOW)).toBeNull();
    }
    expect(parseSignupAttribution(null, NOW)).toBeNull();
    expect(parseSignupAttribution([], NOW)).toBeNull();
  });
});
