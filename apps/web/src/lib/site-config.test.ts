import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppHref,
  buildAuthHref,
  legacyParentCookieNames,
  resolveAppUrl,
  resolveAuthAppUrl,
  resolveAuthCallbackOrigin,
  resolveSupabaseCookieOptions,
} from './site-config';

describe('auth origin resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the exact initiating Preview deployment host', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://auth-staging.graylum.com');

    expect(resolveAuthAppUrl('https://graylum-ai-vercel-v1-preview.vercel.app')).toBe(
      'https://graylum-ai-vercel-v1-preview.vercel.app',
    );
  });

  it('keeps the branch alias origin when the flow starts there', () => {
    expect(resolveAuthCallbackOrigin('https://example-alias.vercel.app')).toBe(
      'https://example-alias.vercel.app',
    );
  });

  it('uses the initiating localhost origin instead of a configured deployment alias', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://auth-staging.graylum.com');

    expect(resolveAuthAppUrl('http://localhost:3127')).toBe('http://localhost:3127');
  });

  it('uses the browser runtime origin by default on a Preview deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://auth-staging.graylum.com');
    vi.stubGlobal('window', {
      location: { origin: 'https://graylum-ai-vercel-v1-preview.vercel.app' },
    });

    expect(resolveAuthAppUrl()).toBe('https://graylum-ai-vercel-v1-preview.vercel.app');
  });

  it('preserves the configured graylum.com auth origin', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://graylum.com/login');

    expect(resolveAuthAppUrl('https://www.graylum.com')).toBe('https://app.graylum.com');
    expect(resolveAuthAppUrl('https://app.graylum.com')).toBe('https://app.graylum.com');
  });
});

describe('staging app host', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps login, callback and verify links on the staging domain', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example-alias.vercel.app');

    expect(resolveAuthAppUrl('https://auth-staging.graylum.com')).toBe('https://auth-staging.graylum.com');
    vi.stubGlobal('window', { location: { origin: 'https://auth-staging.graylum.com' } });
    expect(resolveAuthAppUrl()).toBe('https://auth-staging.graylum.com');
    expect(resolveAppUrl()).toBe('https://auth-staging.graylum.com');
  });

  it('does not trust an unknown graylum.com host as an auth origin', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    expect(resolveAuthAppUrl('https://other.graylum.com')).toBe('https://app.graylum.com');
    expect(resolveAuthAppUrl('https://evilgraylum.com')).toBe('https://app.graylum.com');
  });
});

describe('session cookie scope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shares the parent-domain cookie only on the production hosts', () => {
    for (const host of ['graylum.com', 'www.graylum.com', 'app.graylum.com']) {
      expect(resolveSupabaseCookieOptions(host)).toMatchObject({ domain: '.graylum.com', secure: true });
    }
  });

  it('keeps staging and other hosts on a host-only cookie', () => {
    expect(resolveSupabaseCookieOptions('auth-staging.graylum.com')).toMatchObject({ domain: undefined, secure: true });
    expect(resolveSupabaseCookieOptions('x.app.graylum.com')).toMatchObject({ domain: undefined, secure: true });
    expect(resolveSupabaseCookieOptions('evilgraylum.com')).toMatchObject({ domain: undefined, secure: false });
    expect(resolveSupabaseCookieOptions('example-alias.vercel.app')).toMatchObject({ domain: undefined });
    expect(resolveSupabaseCookieOptions('localhost')).toMatchObject({ domain: undefined, secure: false });
  });

  it('lists only this project\'s old parent-domain session cookies for cleanup on a staging host', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://stagingref.supabase.co');
    const names = [
      'sb-stagingref-auth-token.0',
      'sb-stagingref-auth-token-code-verifier',
      'sb-prodref-auth-token',
      'other',
    ];

    expect(legacyParentCookieNames(names, 'auth-staging.graylum.com')).toEqual([
      'sb-stagingref-auth-token.0',
      'sb-stagingref-auth-token-code-verifier',
    ]);
    expect(legacyParentCookieNames(names, 'app.graylum.com')).toEqual([]);
    expect(legacyParentCookieNames(names, 'example-alias.vercel.app')).toEqual([]);
  });

  it('cleans nothing when the project URL is missing', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(legacyParentCookieNames(['sb--auth-token'], 'auth-staging.graylum.com')).toEqual([]);
  });
});

describe('site links on the server and in the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('stays relative on the server, where no request origin is known', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://auth-staging.graylum.com');
    expect(buildAuthHref('/login?action=signup')).toBe('/login?action=signup');
    expect(buildAppHref('landing')).toBe('/landing');
  });

  it('points at the auth origin in the browser', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example-alias.vercel.app');
    vi.stubGlobal('window', { location: { origin: 'https://auth-staging.graylum.com', hostname: 'auth-staging.graylum.com' } });
    expect(buildAuthHref('/login')).toBe('https://auth-staging.graylum.com/login');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubGlobal('window', { location: { origin: 'https://www.graylum.com', hostname: 'www.graylum.com' } });
    expect(buildAuthHref('/login')).toBe('https://app.graylum.com/login');
  });

  it('keeps redirect URLs sent to GoTrue absolute when built from an explicit origin on the server', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example-alias.vercel.app');
    expect(new URL('/auth/callback', resolveAuthAppUrl('https://auth-staging.graylum.com')).toString())
      .toBe('https://auth-staging.graylum.com/auth/callback');
    expect(resolveAuthAppUrl()).toBe('https://example-alias.vercel.app');
    expect(resolveAuthCallbackOrigin('https://www.graylum.com')).toBe('https://example-alias.vercel.app');
  });
});
