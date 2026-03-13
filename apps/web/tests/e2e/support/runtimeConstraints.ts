/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { FlowIssue } from './monitoring';

export const REGION_RESTRICTION_MESSAGE = 'This model is not available in your region';

export function isLocalPlaywrightBaseUrl(baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? '') {
  return baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost');
}

export function hasRegionRestrictionMessage(text: string) {
  return text.includes(REGION_RESTRICTION_MESSAGE);
}

export async function responseShowsRegionRestriction(response: {
  status(): number;
  text(): Promise<string>;
}) {
  if (response.status() < 400) {
    return false;
  }

  try {
    const body = await response.text();
    return hasRegionRestrictionMessage(body);
  } catch {
    return false;
  }
}

export function probeShowsRegionRestriction(probe: { status: number; body: string }) {
  return probe.status >= 400 && hasRegionRestrictionMessage(probe.body);
}

export function isRegionRestrictionIssue(issue: FlowIssue) {
  if (hasRegionRestrictionMessage(issue.message)) {
    return true;
  }

  return (
    issue.url?.includes('/api/ai/stream') === true &&
    issue.source === 'response' &&
    issue.status === 400
  );
}
