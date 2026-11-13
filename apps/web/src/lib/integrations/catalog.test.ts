/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { connectMessage, INTEGRATIONS, trackedLink } from './catalog';

describe('integration modules', () => {
  it('each module has its introduction, when to use it, and https links to its own pages', () => {
    expect(INTEGRATIONS.map(module => module.id)).toEqual(['shotviva']);
    for (const module of INTEGRATIONS) {
      expect(module.features.length).toBeGreaterThan(0);
      expect(module.whenToUse.length).toBeGreaterThan(0);
      for (const url of [module.viewUrl, module.buyUrl]) {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        // Tracking is added by trackedLink only.
        expect([...parsed.searchParams.keys()]).toEqual([]);
      }
    }
  });

  it('the copy carries no numbers of our own (no counts, prices or promises; Owner to confirm the wording)', () => {
    for (const module of INTEGRATIONS) {
      for (const line of [module.tagline, ...module.features, ...module.whenToUse, ...(module.inGraylum ?? [])]) {
        expect(line, line).not.toMatch(/[0-9０-９]/);
      }
    }
  });

  it('a link marks Graylum as the source with Shotviva\'s partner marker and utm_*, never the affiliate ref', () => {
    const view = new URL(trackedLink('https://shotviva.com/zh', 'shotviva', 'view'));
    expect(view.origin + view.pathname).toBe('https://shotviva.com/zh');
    expect(Object.fromEntries(view.searchParams)).toEqual({ from: 'graylum', utm_source: 'graylum', utm_medium: 'integration',
      utm_campaign: 'shotviva', utm_content: 'view' });
    const buy = new URL(trackedLink('https://shotviva.com/zh/pricing?ref=someone', 'shotviva', 'buy'));
    expect(buy.searchParams.get('utm_content')).toBe('buy');
    expect(buy.pathname).toBe('/zh/pricing');
    expect(trackedLink('https://shotviva.com/zh', 'shotviva', 'view')).not.toContain('ref=graylum');
  });

  it('the page says in plain words what came back from Shotviva', () => {
    expect(connectMessage({ connected: 'connected' })).toMatchObject({ tone: 'success' });
    for (const code of ['SHOTVIVA_STATE_INVALID', 'SHOTVIVA_CODE_INVALID', 'SHOTVIVA_MEMBERSHIP_REQUIRED', 'SHOTVIVA_ACCOUNT_CLOSED',
      'SHOTVIVA_BUSY', 'SHOTVIVA_UNAVAILABLE', 'LOGIN_REQUIRED']) {
      const message = connectMessage({ error: code });
      expect(message?.tone).toBe('error');
      expect(message?.text).not.toMatch(/SHOTVIVA_|[A-Z]{4,}_/);
    }
    expect(connectMessage({ error: 'anything-else' })).toEqual(connectMessage({ error: 'SHOTVIVA_UNAVAILABLE' }));
    expect(connectMessage({})).toBeNull();
  });
});
