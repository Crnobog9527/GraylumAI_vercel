/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { sanitizeRedirectTarget } from './auth';
import { isPublicPathname } from './public-paths';
import { buildRecoveryRedirectUrl, FORGOT_PASSWORD_PATH, RESET_PASSWORD_PATH } from './passwordRecovery';
import { PASSWORD_RESET_DONE_PATH } from '@/hooks/use-password-reset';

// E1: login entry pages stay at the root, so a reset email sent before or after the /app move still works,
// and the visitor ends in the logged-in app under /app once signed in with the new password.
describe('password reset paths after the single-host move', () => {
  it('sends the reset link through the root callback to the root reset page', () => {
    const url = new URL(buildRecoveryRedirectUrl('https://www.graylum.com'));
    expect(url.origin + url.pathname).toBe('https://www.graylum.com/auth/callback');
    expect(url.searchParams.get('next')).toBe('/reset-password');
    expect(url.searchParams.get('flow')).toBe('recovery');
    expect(sanitizeRedirectTarget(RESET_PASSWORD_PATH)).toBe('/reset-password');
  });

  it('opens every page of the flow without a session', () => {
    for (const path of ['/auth/callback', FORGOT_PASSWORD_PATH, RESET_PASSWORD_PATH, '/login']) {
      expect(isPublicPathname(path), path).toBe(true);
    }
  });

  it('logs in after the reset and lands under /app', () => {
    const done = new URL(PASSWORD_RESET_DONE_PATH, 'https://www.graylum.com');
    expect(done.pathname).toBe('/login');
    expect(sanitizeRedirectTarget(done.searchParams.get('redirect'))).toBe('/app/profile');
  });
});
