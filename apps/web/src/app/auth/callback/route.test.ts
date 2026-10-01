import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthCallbackOrigin } from '@/lib/site-config';

const auth = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));
vi.mock('@repo/api/src/root', () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const { GET } = await import('./route');
const callback = async (query: string) => {
  const response = await GET(new NextRequest(`http://127.0.0.1:3000/auth/callback?${query}`));
  return new URL(response.headers.get('location') ?? '');
};

describe('auth callback origin', () => {
  it('keeps callback redirects on the request host for Preview and localhost', () => {
    expect(resolveAuthCallbackOrigin(new URL('https://preview.example.vercel.app/auth/callback'))).toBe(
      'https://preview.example.vercel.app',
    );
    expect(resolveAuthCallbackOrigin(new URL('http://127.0.0.1:3000/auth/callback'))).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('normalizes production public-domain requests to the app auth origin', () => {
    // Isolated from the caller's environment: a configured app URL would correctly win here.
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    try {
      expect(resolveAuthCallbackOrigin(new URL('https://www.graylum.com/auth/callback'))).toBe(
        'https://app.graylum.com',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('auth callback link errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getUser.mockResolvedValue({ data: { user: null } });
  });

  it('sends an expired email link to the resend page with a fixed reason only', async () => {
    const to = await callback('error=access_denied&error_code=otp_expired'
      + '&error_description=%E8%AF%B7%E8%81%94%E7%B3%BB%E5%AE%A2%E6%9C%8D&next=%2Fprofile');
    expect(to.pathname).toBe('/verify-email');
    expect(Object.fromEntries(to.searchParams)).toEqual({ redirect: '/profile', reason: 'expired' });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('sends other link errors to the login page with a code, never the provider text', async () => {
    const to = await callback('error=access_denied&error_description=Pay+here&next=%2Fworkbench%3Ftab%3Da');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'callback_failed', redirect: '/workbench?tab=a' });
  });

  it('uses the same login error code when the code exchange fails', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: new Error('bad code') });
    const to = await callback('code=abc&next=%2F');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'callback_failed', redirect: '/' });
  });

  it.each(['//evil.example', 'https://evil.example/x', '/\\evil.example', 'javascript:alert(1)'])(
    'keeps only the default destination when next is unsafe (%s)',
    async unsafe => {
      const to = await callback(`error=access_denied&next=${encodeURIComponent(unsafe)}`);
      expect(to.hostname).not.toContain('evil');
      expect(to.pathname).toBe('/login');
      expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'callback_failed', redirect: '/profile' });
    },
  );

  it('sends a visit without session to the login page, where a fragment error is read', async () => {
    const to = await callback('next=%2Fprofile');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ redirect: '/profile' });
  });

  it('still sends a signed-in unverified user to the verify page with the email', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    auth.getUser.mockResolvedValue({ data: { user: { email: 'a@example.test', email_confirmed_at: null } } });
    const to = await callback('code=abc&next=%2Fprofile');
    expect(to.pathname).toBe('/verify-email');
    expect(Object.fromEntries(to.searchParams)).toEqual({ email: 'a@example.test', redirect: '/profile' });
  });
});

describe('auth callback after a failed code exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getUser.mockResolvedValue({ data: { user: null } });
  });

  it.each(['pkce_code_verifier_not_found', 'bad_code_verifier', 'flow_state_not_found'])(
    'tells the visitor to log in when the verifier does not match (%s)',
    async code => {
      auth.exchangeCodeForSession.mockResolvedValue({ error: Object.assign(new Error('x'), { code }) });
      const to = await callback('code=abc&next=%2Fprofile');
      expect(to.pathname).toBe('/login');
      expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'link_needs_login', redirect: '/profile' });
    },
  );

  it('drops GoTrue landing parameters from next before redirecting', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    auth.getUser.mockResolvedValue({ data: { user: { email: 'a@example.test', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    const next = encodeURIComponent('/library?item=1&error_code=otp_expired&code=old');
    const to = await callback(`code=abc&next=${next}`);
    expect(`${to.pathname}${to.search}`).toBe('/library?item=1');
  });
});

describe('auth callback failure message by flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getUser.mockResolvedValue({ data: { user: null } });
    auth.exchangeCodeForSession.mockResolvedValue({ error: Object.assign(new Error('x'), { code: 'bad_code_verifier' }) });
  });

  it('asks a Google sign-in to retry Google, not to use a password', async () => {
    const to = await callback('code=abc&next=%2Fprofile&flow=oauth');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'oauth_incomplete', redirect: '/profile' });
  });

  it('keeps the email-link guidance without the Google marker', async () => {
    const to = await callback('code=abc&next=%2Fprofile&flow=anything');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'link_needs_login', redirect: '/profile' });
  });
});
