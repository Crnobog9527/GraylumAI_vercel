/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
vi.mock('@sentry/nextjs', () => ({
  // Resolve the phase callback explicitly; do not depend on the test helper's
  // support for functional Next configs or invoke production env validation.
  withSentryConfig: (config: unknown) =>
    typeof config === 'function' ? config('phase-development-server', { defaultConfig: {} }) : config,
}));
import config from '../../next.config';
import { buildLegacyHostRedirects, buildPathRedirects, SINGLE_HOST_REDIRECTS_ENV } from './single-host-redirects';

// Next.js redirect rules do not depend on the request method; a 308 tells the client to repeat the same method
// and body at the new address (RFC 9110 15.4.9), which is why the permanent rules use it.
async function visit(url: string) {
  const response = await unstable_getResponseFromNextConfig({ url, nextConfig: config });
  const location = response.headers.get('location');
  return { status: response.status, to: location ? decodeURIComponent(location) : null };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The redirects run in next.config, before the proxy's login check and before any page.
describe('old addresses of the logged-in pages on every host (E1)', () => {
  const HOSTS = ['https://www.graylum.com', 'https://auth-staging.graylum.com', 'http://localhost:3000'];

  it.each([
    ['/positioning', '/app/positioning'],
    ['/positioning/draft-1/topics?x=1', '/app/positioning/draft-1/topics?x=1'],
    ['/runtime?session=s1', '/app/runtime?session=s1'],
    ['/profile?tab=subscription&buy=gold&cycle=monthly', '/app/profile?tab=subscription&buy=gold&cycle=monthly'],
    ['/library', '/app/library'],
    ['/library/scan-check', '/app/library/scan-check'],
    ['/marketplace?module=m', '/app/marketplace?module=m'],
    ['/workbench/marketplace', '/app/workbench/marketplace'],
    ['/workbench/search?q=x', '/app/workbench/search?q=x'],
    ['/publish-monitor/connect?request=r&provider=failed', '/app/publish-monitor/connect?request=r&provider=failed'],
    ['/expert-consult?from=pricing', '/app/expert-consult?from=pricing'],
  ])('moves %s to %s with a permanent 308', async (from, to) => {
    for (const origin of HOSTS) {
      expect(await visit(`${origin}${from}`), origin).toEqual({ status: 308, to: `${origin}${to}` });
    }
  });

  // LEGACY-CLOSE: the deleted /chat and /workbench pages open positioning in one step, reversibly.
  it.each(['/chat', '/chat?conversation=old', '/chat?mode=skill&conversation=old', '/workbench', '/workbench?project=old'])(
    'sends %s straight to /app/positioning with a reversible 307',
    async path => {
      const { status, to } = await visit(`https://graylum.test${path}`);
      expect(status).toBe(307);
      expect(new URL(to!).pathname).toBe('/app/positioning');
    },
  );

  it('sends the old public home address to the root, and keeps the other public redirects', async () => {
    expect(await visit('https://www.graylum.com/landing')).toEqual({ status: 308, to: 'https://www.graylum.com/' });
    expect(await visit('https://www.graylum.com/landing/pricing?x=1')).toEqual({
      status: 308,
      to: 'https://www.graylum.com/pricing?x=1',
    });
    expect(await visit('https://www.graylum.com/tutorials')).toEqual({ status: 308, to: 'https://www.graylum.com/blog' });
  });

  it.each(['/', '/app', '/app/positioning', '/app/workbench/search', '/landing/preview/l', '/login', '/auth/callback',
    '/api/stripe/webhook', '/admin', '/pricing', '/profiles', '/positioning-x', '/chatroom'])(
    'leaves %s alone', async path => {
      expect((await visit(`https://www.graylum.com${path}`)).to).toBeNull();
    },
  );
});

// Vercel compiles these rules into its own router, where an empty ":path*" leaves a trailing slash and costs a
// second 308 (#1206 validation, step 6). No rule may end its destination in a wildcard that can be empty.
describe('redirect rules without empty wildcards', () => {
  it('never uses ":path*" in a destination, so a folder address goes to its final page in one step', async () => {
    vi.stubEnv(SINGLE_HOST_REDIRECTS_ENV, 'true');
    const rules = [...buildLegacyHostRedirects('true'), ...buildPathRedirects()];
    expect(rules.filter(rule => rule.destination.includes(':path*'))).toEqual([]);
    for (const rule of rules) {
      expect(rule.destination.endsWith('/') && rule.destination !== '/' && !rule.destination.endsWith('graylum.com/'),
        rule.destination).toBe(false);
    }
  });

  it.each(['/profile', '/positioning', '/library', '/workbench/search'])('has an exact rule for %s', path => {
    const exact = buildPathRedirects().find(rule => rule.source === path || rule.source === `/${path.split('/')[1]}`);
    expect(exact, path).toBeDefined();
  });
});

describe('old production hosts', () => {
  it('serve as they are while the switch is off, so the Vercel www 307 cannot loop (E2 first)', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'on']) {
      if (value === undefined) vi.stubEnv(SINGLE_HOST_REDIRECTS_ENV, undefined as unknown as string);
      else vi.stubEnv(SINGLE_HOST_REDIRECTS_ENV, value);
      for (const url of ['https://app.graylum.com/', 'https://app.graylum.com/login', 'https://graylum.com/pricing']) {
        expect((await visit(url)).to, `${value}: ${url}`).toBeNull();
      }
    }
  });

  describe('with the switch on', () => {
    const on = () => vi.stubEnv(SINGLE_HOST_REDIRECTS_ENV, 'true');

    it.each([
      ['https://app.graylum.com/', 'https://www.graylum.com/app'],
      ['https://app.graylum.com/positioning/draft-1?x=1', 'https://www.graylum.com/app/positioning/draft-1?x=1'],
      ['https://app.graylum.com/profile?tab=subscription', 'https://www.graylum.com/app/profile?tab=subscription'],
      ['https://app.graylum.com/workbench/search', 'https://www.graylum.com/app/workbench/search'],
      ['https://app.graylum.com/chat?conversation=old', 'https://www.graylum.com/app/positioning?conversation=old'],
      ['https://app.graylum.com/landing', 'https://www.graylum.com/'],
      // Only the host changes for login entry pages, auth, API, admin and public pages. Next.js serves its own
      // /_next files without redirects, so a page still open on the old host keeps loading them.
      ['https://app.graylum.com/auth/callback?code=abc&next=%2Fprofile', 'https://www.graylum.com/auth/callback?code=abc&next=/profile'],
      ['https://app.graylum.com/login?redirect=%2Fprofile', 'https://www.graylum.com/login?redirect=/profile'],
      ['https://app.graylum.com/verify-email?redirect=%2F', 'https://www.graylum.com/verify-email?redirect=/'],
      ['https://app.graylum.com/reset-password', 'https://www.graylum.com/reset-password'],
      ['https://app.graylum.com/api/stripe/webhook', 'https://www.graylum.com/api/stripe/webhook'],
      ['https://app.graylum.com/api/cron/runtime-recovery', 'https://www.graylum.com/api/cron/runtime-recovery'],
      ['https://app.graylum.com/admin/users', 'https://www.graylum.com/admin/users'],
      ['https://app.graylum.com/pricing', 'https://www.graylum.com/pricing'],
      // GoTrue's Site URL fallback keeps the root, which hands the code or error to the callback or login.
      ['https://app.graylum.com/?code=abc', 'https://www.graylum.com/?code=abc'],
      ['https://app.graylum.com/?error=access_denied&error_code=otp_expired', 'https://www.graylum.com/?error=access_denied&error_code=otp_expired'],
      // The bare domain keeps path and query; old addresses still go straight to their final page.
      ['https://graylum.com/', 'https://www.graylum.com/'],
      ['https://graylum.com/zh-tw/about?utm_source=x', 'https://www.graylum.com/zh-tw/about?utm_source=x'],
      ['https://graylum.com/profile', 'https://www.graylum.com/app/profile'],
      ['https://graylum.com/landing/pricing', 'https://www.graylum.com/pricing'],
    ])('sends %s to %s in one permanent 308', async (from, to) => {
      on();
      expect(await visit(from)).toEqual({ status: 308, to });
    });

    it('answers a late payment webhook with a 308, which keeps POST and its body (D4 moves it first)', async () => {
      on();
      expect(await visit('https://app.graylum.com/api/stripe/webhook')).toEqual({
        status: 308,
        to: 'https://www.graylum.com/api/stripe/webhook',
      });
    });

    it('leaves www, staging, previews and look-alike hosts alone', async () => {
      on();
      for (const url of ['https://www.graylum.com/', 'https://www.graylum.com/app', 'https://auth-staging.graylum.com/',
        'https://auth-staging.graylum.com/login', 'https://x.vercel.app/', 'https://evilgraylum.com/',
        'https://app.graylum.com.evil.example/', 'https://xapp.graylum.com/']) {
        expect((await visit(url)).to, url).toBeNull();
      }
    });
  });
});
