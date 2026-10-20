import { describe, expect, it } from 'vitest';
import { pageTitleFor, sanitizePageUrl, sanitizeReferrer } from './sanitize';
import { registeredUtm } from './utm-registry';

const ORIGIN = 'https://auth-staging.graylum.com';

describe('sanitizePageUrl', () => {
  it('keeps only the template and registered UTM values', () => {
    expect(sanitizePageUrl(`${ORIGIN}/app/positioning/draft-123?tab=x&utm_source=YouTube&utm_medium=video#frag`))
      .toBe(`${ORIGIN}/app/positioning/[draftId]?utm_source=youtube&utm_medium=video`);
  });

  it('drops unregistered UTM values that may name a person', () => {
    expect(sanitizePageUrl(`${ORIGIN}/landing?utm_source=someone@example.com&utm_campaign=Alice.Smith`)).toBe(`${ORIGIN}/landing`);
    expect(registeredUtm('?utm_campaign=Alice.Smith&utm_term=x')).toEqual([]);
  });

  it('never reports one-time keys or personal data in sensitive addresses', () => {
    expect(sanitizePageUrl(`${ORIGIN}/auth/callback?code=secret`)).toBeNull();
    expect(sanitizePageUrl(`${ORIGIN}/verify-email?email=a@b.c`)).toBeNull();
    expect(sanitizePageUrl(`${ORIGIN}/reset-password#access_token=x`)).toBeNull();
    expect(sanitizePageUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizePageUrl('not a url')).toBeNull();
  });

  it('strips the query from login addresses', () => {
    expect(sanitizePageUrl(`${ORIGIN}/login?redirect=/positioning/abc&invite=code`)).toBe(`${ORIGIN}/login`);
  });
});

describe('sanitizeReferrer', () => {
  it('keeps only the origin of another site', () => {
    expect(sanitizeReferrer('https://chatgpt.com/c/abc-private-thread?x=1', ORIGIN)).toBe('https://chatgpt.com');
    expect(sanitizeReferrer('https://www.reddit.com/user/alice/', ORIGIN)).toBe('https://www.reddit.com');
  });

  it('turns this site into a template, or its origin when the page is not reportable', () => {
    expect(sanitizeReferrer(`${ORIGIN}/app/positioning/draft-1?x=1`, ORIGIN)).toBe(`${ORIGIN}/app/positioning/[draftId]`);
    expect(sanitizeReferrer(`${ORIGIN}/verify-email?email=a@b.c`, ORIGIN)).toBe(ORIGIN);
    expect(sanitizeReferrer(`${ORIGIN}/auth/callback?code=x`, ORIGIN)).toBe(ORIGIN);
  });

  it('ignores empty or odd referrers', () => {
    expect(sanitizeReferrer('', ORIGIN)).toBe('');
    expect(sanitizeReferrer('android-app://com.x', ORIGIN)).toBe('');
  });
});

describe('pageTitleFor', () => {
  it('is the template path', () => {
    expect(pageTitleFor(`${ORIGIN}/app/positioning/[draftId]?utm_source=youtube`)).toBe('/app/positioning/[draftId]');
  });
});
