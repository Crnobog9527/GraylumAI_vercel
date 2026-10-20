/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { authFragmentForwardTarget } from './AuthFragmentForward';

describe('GoTrue fragment on the public home page', () => {
  it.each([
    '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
    '#error=server_error',
    '#access_token=a&refresh_token=b&type=signup',
  ])('hands %s to the login page unchanged', hash => {
    expect(authFragmentForwardTarget(hash)).toBe(`/login${hash}`);
  });

  it.each(['', '#', '#how-it-works', '#faq'])('leaves an ordinary anchor %j on the home page', hash => {
    expect(authFragmentForwardTarget(hash)).toBeNull();
  });
});
