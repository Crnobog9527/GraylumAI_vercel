import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAuthAppUrl, resolveAuthCallbackOrigin } from './site-config';

describe('auth origin resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the exact initiating Preview deployment host', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://graylumai-staging.vercel.app');

    expect(resolveAuthAppUrl('https://graylum-ai-vercel-v1-preview.vercel.app')).toBe(
      'https://graylum-ai-vercel-v1-preview.vercel.app',
    );
  });

  it('keeps the branch alias origin when the flow starts there', () => {
    expect(resolveAuthCallbackOrigin('https://graylumai-staging.vercel.app')).toBe(
      'https://graylumai-staging.vercel.app',
    );
  });

  it('uses the initiating localhost origin instead of a configured deployment alias', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://graylumai-staging.vercel.app');

    expect(resolveAuthAppUrl('http://localhost:3127')).toBe('http://localhost:3127');
  });

  it('uses the browser runtime origin by default on a Preview deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', 'https://graylumai-staging.vercel.app');
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
