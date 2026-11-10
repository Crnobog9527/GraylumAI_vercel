import { describe, expect, it } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { parseRegionCookie, regionCookieFor, regionForCountry } from './consent-region';
import { regionOverrideAllowed, withConsentRegion } from './consent-region-proxy';

// Vercel's own variables as each project sets them.
const PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' };
const STAGING = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'staging', VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com' };

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
  it('is never allowed on the production site (same rule as the payment notices)', () => {
    expect(regionOverrideAllowed(PRODUCTION, 'www.graylum.com')).toBe(false);
    // Any deployment of the production project, any branch or address.
    expect(regionOverrideAllowed({ ...PRODUCTION, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'x' }, 'x.vercel.app')).toBe(false);
    // A production domain, whatever the variables say.
    expect(regionOverrideAllowed({}, 'www.graylum.com')).toBe(false);
    expect(regionOverrideAllowed({}, 'graylum.com')).toBe(false);
    expect(regionOverrideAllowed({}, 'APP.graylum.com.')).toBe(false);
    // The app says it is production.
    expect(regionOverrideAllowed({ ...STAGING, APP_ENV: 'production' }, 'auth-staging.graylum.com')).toBe(false);
    expect(regionOverrideAllowed({ NEXT_PUBLIC_APP_ENV: 'production' }, 'localhost')).toBe(false);
  });

  it('is allowed on staging, previews and local runs', () => {
    expect(regionOverrideAllowed(STAGING, 'auth-staging.graylum.com')).toBe(true);
    expect(regionOverrideAllowed({ ...STAGING, VERCEL_ENV: 'preview' }, 'graylumai-staging-x.vercel.app')).toBe(true);
    expect(regionOverrideAllowed({ NODE_ENV: 'development' }, 'localhost')).toBe(true);
  });

  it('pins the class until auto; when refused it ignores the parameter and replaces a pinned value', () => {
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
  const run = (url: string, env: Record<string, string>, headers: Record<string, string> = {}) =>
    withConsentRegion(new NextRequest(url, { headers }), NextResponse.next(), env);

  it('from x-vercel-ip-country, readable by the page and only the class', () => {
    const cookie = run('https://www.graylum.com/landing', PRODUCTION, { 'x-vercel-ip-country': 'US' }).cookies.get('gl_consent_region');
    expect(cookie).toMatchObject({ value: 'optout', path: '/', sameSite: 'lax', secure: true, httpOnly: false });
    expect(run('https://www.graylum.com/landing', PRODUCTION, { 'x-vercel-ip-country': 'DE' }).cookies.get('gl_consent_region')?.value)
      .toBe('optin');
    expect(run('https://www.graylum.com/landing', PRODUCTION).cookies.get('gl_consent_region')?.value).toBe('optin');
  });

  it('writes nothing when the browser already has the right value', () => {
    const response = run('https://www.graylum.com/faq', PRODUCTION, { 'x-vercel-ip-country': 'US', cookie: 'gl_consent_region=optout' });
    expect(response.cookies.get('gl_consent_region')).toBeUndefined();
  });

  it('takes the override on staging', () => {
    expect(run('https://auth-staging.graylum.com/landing?consent_region=optin', STAGING, { 'x-vercel-ip-country': 'US' })
      .cookies.get('gl_consent_region')?.value).toBe('test-optin');
    expect(run('https://auth-staging.graylum.com/landing?consent_region=optout', STAGING, { 'x-vercel-ip-country': 'DE' })
      .cookies.get('gl_consent_region')?.value).toBe('test-optout');
  });

  it('the override does nothing on the production site, and a pinned test value goes back to the country', () => {
    expect(run('https://www.graylum.com/landing?consent_region=optout', PRODUCTION, { 'x-vercel-ip-country': 'DE' })
      .cookies.get('gl_consent_region')?.value).toBe('optin');
    expect(run('https://www.graylum.com/landing?consent_region=optin', PRODUCTION,
      { 'x-vercel-ip-country': 'US', cookie: 'gl_consent_region=test-optin' }).cookies.get('gl_consent_region')?.value).toBe('optout');
  });
});
