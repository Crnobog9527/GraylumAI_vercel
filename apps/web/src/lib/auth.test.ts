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
