/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { sanitizeRedirectTarget } from './auth';

describe('sanitizeRedirectTarget', () => {
  it.each(['/profile', '/', '/library?item=one#details', '/runtime?session=one'])
    ('retains a local target %s', value => expect(sanitizeRedirectTarget(value)).toBe(value));
  it.each([null, undefined, '', 'javascript:alert(1)', '//evil.example',
    '/\\evil.example', '/\nevil.example', '/\r/evil.example', '/\t/evil.example',
    'https://evil.example', 'data:text/html,test', ' /profile', '/profile\u0000'])
    ('rejects an unsafe target %j', value => expect(sanitizeRedirectTarget(value)).toBe('/profile'));
});

describe('sanitizeRedirectTarget with auth landing parameters', () => {
  it.each([
    ['/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid', '/profile'],
    ['/?code=abc', '/profile'],
    ['/#error=access_denied&error_code=otp_expired', '/profile'],
    ['/profile?tab=a&error_code=otp_expired', '/profile?tab=a'],
    ['/library?item=one&code=abc#error=x&section=2', '/library?item=one#section=2'],
    ['/runtime?error_description=x#details', '/runtime#details'],
  ])('strips GoTrue parameters from %s', (value, expected) => {
    expect(sanitizeRedirectTarget(value)).toBe(expected);
  });

  it.each(['/profile?tab=a', '/library?item=one#details', '/search?q=error+code', '/?tab=a'])
    ('keeps ordinary parameters in %s untouched', value => expect(sanitizeRedirectTarget(value)).toBe(value));

  it('cannot be turned into a protocol-relative target by stripping', () => {
    expect(sanitizeRedirectTarget('/.//evil.example?code=abc')).toBe('/.//evil.example');
    expect(sanitizeRedirectTarget('/?code=a#//evil')).toBe('/#//evil');
  });
});
