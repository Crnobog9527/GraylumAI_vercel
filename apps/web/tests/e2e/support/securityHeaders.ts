/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Matches the current global response-header policy in next.config.ts. CSP is report-only, not enforcement. */
export function securityHeaderProblems(headers: Record<string, string>): string[] {
  const problems: string[] = [];
  if (headers['x-frame-options']?.toUpperCase() !== 'DENY') problems.push('x-frame-options');
  if (headers['x-content-type-options']?.toLowerCase() !== 'nosniff') problems.push('x-content-type-options');
  const directives = (headers['content-security-policy-report-only'] ?? '').split(';').map(value => value.trim());
  if (!directives.includes("frame-ancestors 'none'") || !directives.includes("object-src 'none'")) {
    problems.push('content-security-policy-report-only');
  }
  return problems;
}
