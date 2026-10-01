import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

describe('/register', () => {
  it('redirects to the sign-up form on the same host', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://auth-staging.graylum.com');
    const { default: RegisterPage } = await import('./page');
    RegisterPage();
    expect(redirect).toHaveBeenCalledWith('/login?action=signup');
    vi.unstubAllEnvs();
  });
});
