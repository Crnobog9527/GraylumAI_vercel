import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanVercelEvent } from './vercel';

const ORIGIN = 'https://auth-staging.graylum.com';
const withConsent = (analytics: boolean) => vi.stubGlobal('window', { Termly: { getConsentState: () => ({ analytics }) } });
afterEach(() => vi.unstubAllGlobals());

describe('cleanVercelEvent', () => {
  it('drops events without live consent when the category is analytics', () => {
    withConsent(false);
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/landing` }, 'analytics')).toBeNull();
  });

  it('reports essential-category events without consent, still cleaned', () => {
    withConsent(false);
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/login?redirect=/x&utm_source=reddit` }, 'essential'))
      .toEqual({ type: 'pageview', url: `${ORIGIN}/login?utm_source=reddit` });
  });

  it('replaces IDs with the template and drops sensitive pages', () => {
    withConsent(true);
    expect(cleanVercelEvent({ type: 'vital', url: `${ORIGIN}/app/positioning/abc/plan`, route: '/app/positioning/abc/plan' }, 'analytics'))
      .toEqual({ type: 'vital', url: `${ORIGIN}/app/positioning/[draftId]/plan`, route: '/app/positioning/[draftId]/plan' });
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/auth/callback?code=x` }, 'analytics')).toBeNull();
    expect(cleanVercelEvent({ type: 'pageview', url: `${ORIGIN}/verify-email?email=a@b.c` }, 'essential')).toBeNull();
  });
});
