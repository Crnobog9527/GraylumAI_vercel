/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { securityHeaderProblems } from './securityHeaders';

const configured = {
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  'content-security-policy-report-only': "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
};
describe('current response-header contract', () => {
  it('accepts the configured frame, MIME and report-only CSP headers without requiring obsolete XSS headers', () => {
    expect(securityHeaderProblems(configured)).toEqual([]);
  });
  it('rejects a response with no security headers', () => {
    expect(securityHeaderProblems({})).toEqual(['x-frame-options', 'x-content-type-options', 'content-security-policy-report-only']);
  });
  it.each([
    [{ ...configured, 'x-frame-options': '' }, 'x-frame-options'],
    [{ ...configured, 'x-frame-options': 'ALLOW' }, 'x-frame-options'],
    [{ ...configured, 'x-content-type-options': '' }, 'x-content-type-options'],
    [{ ...configured, 'x-content-type-options': 'wrong' }, 'x-content-type-options'],
    [{ ...configured, 'content-security-policy-report-only': '' }, 'content-security-policy-report-only'],
    [{ ...configured, 'content-security-policy-report-only': "frame-ancestors *; object-src 'none'" }, 'content-security-policy-report-only'],
    [{ ...configured, 'content-security-policy-report-only': "frame-ancestors 'none'; object-src *" }, 'content-security-policy-report-only'],
  ])('rejects missing or wrong %s', (headers, problem) => {
    expect(securityHeaderProblems(headers)).toContain(problem);
  });
});
