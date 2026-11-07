import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { parseRegionCookie, regionCookieFor, regionForCountry, regionOverrideAllowed } from './consent-region';
import { withConsentRegion } from './consent-region-proxy';

afterEach(() => vi.unstubAllEnvs());

describe('region class from the country (ANALYTICS-CONSENT)', () => {
  it.each(['DE', 'FR', 'ie', 'NO', 'IS', 'LI', 'GB', 'CH', 'RE', 'AX'])('%s is opt-in', country => {
    expect(regionForCountry(country)).toBe('optin');
  });

  it.each(['US', 'CA', 'TW', 'CN', 'JP', 'AU', 'BR'])('%s is opt-out', country => {
    expect(regionForCountry(country)).toBe('optout');
  });

  it.each([null, undefined, '', 'XX', 'USA', '1', 'E'])('unknown country %j is opt-in (the safe default)', country => {
    expect(regionForCountry(country)).toBe('optin');
  });
});

describe('test override', () => {
  it('is never allowed in production', () => {
    expect(regionOverrideAllowed({ APP_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(false);
    expect(regionOverrideAllowed({ NEXT_PUBLIC_APP_ENV: 'production' })).toBe(false);
    expect(regionOverrideAllowed({ VERCEL_ENV: 'production' })).toBe(false);
    expect(regionOverrideAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is allowed on previews, staging and development', () => {
    expect(regionOverrideAllowed({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(true);
    expect(regionOverrideAllowed({ APP_ENV: 'staging', VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(true);
    expect(regionOverrideAllowed({ NODE_ENV: 'development' })).toBe(true);
    // The staging project's main deployment is a Vercel production deployment; its address says staging.
    expect(regionOverrideAllowed({ VERCEL_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://auth-staging.graylum.com' }))
      .toBe(true);
  });

  it('the production address never allows it, also without APP_ENV', () => {
    expect(regionOverrideAllowed({ VERCEL_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://www.graylum.com' }))
      .toBe(false);
    expect(regionOverrideAllowed({ APP_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://auth-staging.graylum.com' })).toBe(false);
    expect(regionOverrideAllowed({ VERCEL_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://notstaging.example.com' })).toBe(false);
  });

  it('pins the class until auto, and production ignores it and replaces a pinned value', () => {
    const base = { country: 'US', current: null, override: null, overrideAllowed: true };
    expect(regionCookieFor({ ...base, override: 'optin' })).toEqual({ region: 'optin', test: true });
    expect(regionCookieFor({ ...base, current: 'test-optin' })).toEqual({ region: 'optin', test: true });
    expect(regionCookieFor({ ...base, current: 'test-optin', override: 'auto' })).toEqual({ region: 'optout', test: false });
    expect(regionCookieFor({ ...base, override: 'bogus' })).toEqual({ region: 'optout', test: false });
    expect(regionCookieFor({ ...base, overrideAllowed: false, override: 'optin', current: 'test-optin' }))
      .toEqual({ region: 'optout', test: false });
  });

  it('parses only known cookie values', () => {
    expect(parseRegionCookie('optout')).toEqual({ region: 'optout', test: false });
    expect(parseRegionCookie('test-optin')).toEqual({ region: 'optin', test: true });
    expect(parseRegionCookie('granted')).toBeNull();
    expect(parseRegionCookie(null)).toBeNull();
  });
});

describe('the proxy leaves the class on the response', () => {
  const run = (url: string, headers: Record<string, string> = {}) => {
    const request = new NextRequest(url, { headers });
    return withConsentRegion(request, NextResponse.next());
  };

  it('from x-vercel-ip-country, readable by the page and only the class', () => {
    vi.stubEnv('APP_ENV', 'production');
    const cookie = run('https://www.graylum.com/landing', { 'x-vercel-ip-country': 'US' }).cookies.get('gl_consent_region');
    expect(cookie).toMatchObject({ value: 'optout', path: '/', sameSite: 'lax', secure: true, httpOnly: false });
    expect(run('https://www.graylum.com/landing', { 'x-vercel-ip-country': 'DE' }).cookies.get('gl_consent_region')?.value)
      .toBe('optin');
    expect(run('https://www.graylum.com/landing').cookies.get('gl_consent_region')?.value).toBe('optin');
  });

  it('writes nothing when the browser already has the right value', () => {
    vi.stubEnv('APP_ENV', 'production');
    const response = run('https://www.graylum.com/faq', { 'x-vercel-ip-country': 'US', cookie: 'gl_consent_region=optout' });
    expect(response.cookies.get('gl_consent_region')).toBeUndefined();
  });

  it('takes the test override on a preview, not in production', () => {
    vi.stubEnv('APP_ENV', '');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(run('https://preview.vercel.app/landing?consent_region=optin', { 'x-vercel-ip-country': 'US' })
      .cookies.get('gl_consent_region')?.value).toBe('test-optin');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.graylum.com');
    expect(run('https://www.graylum.com/landing?consent_region=optin', { 'x-vercel-ip-country': 'US', cookie: 'gl_consent_region=test-optin' })
      .cookies.get('gl_consent_region')?.value).toBe('optout');
  });
});
