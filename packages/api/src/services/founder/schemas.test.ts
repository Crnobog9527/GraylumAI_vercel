/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { founderWallEntryInput, founderWallLink } from './schemas';

describe('founderWallLink', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['  https://www.xiaohongshu.com/user/profile/abc?x=1  ', 'https://www.xiaohongshu.com/user/profile/abc?x=1'],
    ['https://例子.测试/路径', 'https://xn--fsqu00a.xn--0zwm56d/%E8%B7%AF%E5%BE%84'],
  ])('accepts and normalizes %s', (input, expected) => {
    expect(founderWallLink(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)', 'data:text/html,x', 'http://example.com/', '/founders', '//evil.example/',
    'https://a@evil.example/', 'https://a:b@evil.example/', 'https:///evil', 'https://exa\u0007mple.com/',
    'https://example.com\\@evil.example/', '', null, undefined,
  ])('rejects %s', input => {
    expect(founderWallLink(input as string | null | undefined)).toBeNull();
  });
});

describe('founderWallEntryInput', () => {
  const entry = { displayName: ' 小灰 ', socialAccounts: [{ platform: 'douyin', handle: '小灰', url: 'https://www.douyin.com/user/x' }] };

  it('trims text, normalizes links and turns empty optionals into null', () => {
    expect(founderWallEntryInput.parse({ ...entry, productName: '', productUrl: '', intro: '' })).toEqual({
      displayName: '小灰', socialAccounts: [{ platform: 'douyin', handle: '小灰', url: 'https://www.douyin.com/user/x' }],
      productName: null, productUrl: null, intro: null,
    });
  });

  it.each([
    [{ ...entry, productUrl: 'https://example.com/' }, 'a product link needs a product name'],
    [{ ...entry, productName: 'p', productUrl: 'https://u@example.com/' }, 'credentials in a link'],
    [{ ...entry, socialAccounts: [{ platform: 'myspace', handle: 'x', url: 'https://example.com/' }] }, 'unknown platform'],
    [{ ...entry, socialAccounts: Array(4).fill(entry.socialAccounts[0]) }, 'more than 3 accounts'],
    [{ ...entry, intro: 'x'.repeat(121) }, 'intro over 120 characters'],
    [{ ...entry, displayName: 'a\u0000b' }, 'control characters'],
    [{ ...entry, userId: '00000000-0000-4000-8000-000000000000' }, 'naming another profile'],
  ] as [unknown, string][])('rejects %#: %s', input => {
    expect(founderWallEntryInput.safeParse(input).success).toBe(false);
  });
});
