import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanVercelEvent } from './vercel';

const live = vi.hoisted(() => ({ consent: false }));
vi.mock('./consent', () => ({ analyticsAllowed: () => live.consent }));

const ORIGIN = 'https://auth-staging.graylum.com';
afterEach(() => { live.consent = false; });

describe('cleanVercelEvent', () => {
  it('reports Web Analytics page views for every visitor, without consent, still cleaned (ANALYTICS-CONSENT)', () => {
    live.consent = false;
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/login?redirect=/x&utm_source=reddit` }, 'web-analytics', 'analytics'))
      .toEqual({ type: 'pageview', url: `${ORIGIN}/login?utm_source=reddit` });
    live.consent = true;
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/landing` }, 'web-analytics', 'analytics'))
      .toEqual({ type: 'pageview', url: `${ORIGIN}/landing` });
  });

  it('keeps Speed Insights behind consent unless its category is essential', () => {
    live.consent = false;
    expect(cleanVercelEvent({ type: 'vital', url: `${ORIGIN}/landing` }, 'speed-insights', 'analytics')).toBeNull();
    expect(cleanVercelEvent({ type: 'vital', url: `${ORIGIN}/landing` }, 'speed-insights', 'essential'))
      .toEqual({ type: 'vital', url: `${ORIGIN}/landing` });
    live.consent = true;
    expect(cleanVercelEvent({ type: 'vital', url: `${ORIGIN}/landing` }, 'speed-insights', 'analytics'))
      .toEqual({ type: 'vital', url: `${ORIGIN}/landing` });
  });

  it('replaces IDs with the template and drops sensitive pages', () => {
    live.consent = true;
    expect(cleanVercelEvent({ type: 'vital', url: `${ORIGIN}/app/positioning/abc/topics`, route: '/app/positioning/abc/topics' },
      'speed-insights', 'analytics'))
      .toEqual({ type: 'vital', url: `${ORIGIN}/app/positioning/[draftId]/topics`, route: '/app/positioning/[draftId]/topics' });
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/auth/callback?code=x` }, 'web-analytics', 'analytics')).toBeNull();
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/verify-email?email=a@b.c` }, 'web-analytics', 'essential')).toBeNull();
  });
});
