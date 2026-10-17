/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { getClientIp } from './clientIp';

describe('getClientIp', () => {
  it('prefers the first forwarded IP when multiple proxies are present', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.1, 198.51.100.2',
      'x-real-ip': '198.51.100.9',
    });

    expect(getClientIp(headers)).toBe('203.0.113.1');
  });

  it('falls back to x-real-ip when forwarded headers are absent', () => {
    const headers = new Headers({
      'x-real-ip': '198.51.100.9',
    });

    expect(getClientIp(headers)).toBe('198.51.100.9');
  });
});
