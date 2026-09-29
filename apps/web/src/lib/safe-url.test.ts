/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { isAllowedHttpsUrl, isSafeRelativePath } from './safe-url';

const origins = ['https://graylum.com', 'https://www.graylum.com'];
describe('explicit HTTPS destinations', () => {
  it.each(['https://graylum.com', 'https://www.graylum.com/profile?tab=tickets',
    'https://graylum.com:443/landing'])('allows %s', value => {
    expect(isAllowedHttpsUrl(value, origins)).toBe(true);
  });
  it.each(['javascript:alert(1)', '//evil.example', '/profile', 'https://evil.example/graylum.com',
    'https://graylum.com.evil.example', 'https://notgraylum.com', 'https://app.graylum.com',
    'https://graylum.com:444/', 'http://graylum.com', 'https://graylum.com@evil.example',
    'https://user@graylum.com', 'https://graylum.com\n.evil.example',
    'https://graylum.com\\@evil.example', 'https://', ' https://graylum.com'])
    ('rejects %j', value => expect(isAllowedHttpsUrl(value, origins)).toBe(false));
});

describe('relative paths', () => {
  it.each(['/', '/library', '/library?q=中文%20内容', '/profile?return=https%3A%2F%2Fexample.test'])
    ('allows %s', value => expect(isSafeRelativePath(value)).toBe(true));
  it.each(['//evil.example', '/\\evil.example', '/\n/evil.example', 'javascript:alert(1)',
    'https://example.test', '/\u0000test', '/test\u007f', '/test path'])
    ('rejects %j', value => expect(isSafeRelativePath(value)).toBe(false));
});
