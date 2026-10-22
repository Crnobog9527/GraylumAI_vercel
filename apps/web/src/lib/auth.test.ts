/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { sanitizeRedirectTarget } from './auth';

describe('sanitizeRedirectTarget', () => {
  it.each(['/app/profile', '/app', '/app/library?item=one#details', '/app/runtime?session=one', '/pricing', '/zh-tw/about'])
    ('retains a local target %s', value => expect(sanitizeRedirectTarget(value)).toBe(value));
  // E1: an address from before the /app move (a saved return target, an email link) lands on the moved page.
  it.each([
    ['/', '/app'],
    ['/?tab=a', '/app?tab=a'],
    ['/profile', '/app/profile'],
    ['/profile?tab=security#top', '/app/profile?tab=security#top'],
    ['/positioning/draft-1/topics?x=1', '/app/positioning/draft-1/topics?x=1'],
    ['/library?item=one#details', '/app/library?item=one#details'],
    ['/workbench/search', '/app/workbench/search'],
    ['/publish-monitor/connect?request=r', '/app/publish-monitor/connect?request=r'],
    ['/workbench/search/', '/app/workbench/search/'],
  ])('moves the old address %s to %s', (value, expected) => expect(sanitizeRedirectTarget(value)).toBe(expected));
  // The retired /chat and the page-less /workbench folder are not moved (Owner 2026-10-21); they answer 404.
  it.each(['/chat', '/chat?conversation=old', '/workbench', '/workbench/', '/workbench?project=old'])
    ('leaves the retired address %s as it is', value => expect(sanitizeRedirectTarget(value)).toBe(value));
  it.each(['/profiles', '/positioning-x', '/apps', '/admin/users', '/login', '/chatroom'])
    ('leaves %s alone, matching whole segments only', value => expect(sanitizeRedirectTarget(value)).toBe(value));
  it.each([null, undefined, '', 'javascript:alert(1)', '//evil.example',
    '/\\evil.example', '/\nevil.example', '/\r/evil.example', '/\t/evil.example',
    'https://evil.example', 'data:text/html,test', ' /profile', '/profile\u0000'])
    ('rejects an unsafe target %j', value => expect(sanitizeRedirectTarget(value)).toBe('/app/profile'));
});

describe('sanitizeRedirectTarget with auth landing parameters', () => {
  it.each([
    ['/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid', '/app/profile'],
    ['/?code=abc', '/app/profile'],
    ['/#error=access_denied&error_code=otp_expired', '/app/profile'],
    ['/app/profile?tab=a&error_code=otp_expired', '/app/profile?tab=a'],
    ['/app/library?item=one&code=abc#error=x&section=2', '/app/library?item=one#section=2'],
    ['/app/runtime?error_description=x#details', '/app/runtime#details'],
  ])('strips GoTrue parameters from %s', (value, expected) => {
    expect(sanitizeRedirectTarget(value)).toBe(expected);
  });

  it.each(['/app/profile?tab=a', '/app/library?item=one#details', '/search?q=error+code', '/app?tab=a'])
    ('keeps ordinary parameters in %s untouched', value => expect(sanitizeRedirectTarget(value)).toBe(value));

  it('cannot be turned into a protocol-relative target by stripping', () => {
    expect(sanitizeRedirectTarget('/.//evil.example?code=abc')).toBe('/.//evil.example');
    expect(sanitizeRedirectTarget('/?code=a#//evil')).toBe('/app#//evil');
  });
});
