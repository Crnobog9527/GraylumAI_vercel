import { describe, expect, it } from 'vitest';
import { resolveAuthCallbackOrigin } from '@/lib/site-config';

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
    expect(resolveAuthCallbackOrigin(new URL('https://www.graylum.com/auth/callback'))).toBe(
      'https://app.graylum.com',
    );
  });
});
