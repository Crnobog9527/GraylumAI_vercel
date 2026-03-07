/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Page } from '@playwright/test';

const VERCEL_BYPASS_COOKIE_NAME = '_vercel_jwt';

function getRemoteBaseUrl() {
  return process.env.PLAYWRIGHT_BASE_URL ?? '';
}

function getBypassCookieValue() {
  return process.env.VERCEL_BYPASS_COOKIE ?? '';
}

export async function applyDeploymentProtectionBypass(page: Page) {
  const baseUrl = getRemoteBaseUrl();
  const bypassCookieValue = getBypassCookieValue();

  if (!baseUrl || !bypassCookieValue) {
    return;
  }

  const hostname = new URL(baseUrl).hostname;
  await page.context().addCookies([
    {
      name: VERCEL_BYPASS_COOKIE_NAME,
      value: bypassCookieValue,
      domain: hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

export async function gotoWithBypass(
  page: Page,
  url: string,
  options?: Parameters<Page['goto']>[1],
) {
  await applyDeploymentProtectionBypass(page);
  return page.goto(url, options);
}
