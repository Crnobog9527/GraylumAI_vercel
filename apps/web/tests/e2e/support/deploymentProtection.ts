/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Page } from '@playwright/test';

const VERCEL_BYPASS_COOKIE_NAME = '_vercel_jwt';
const VERCEL_BYPASS_HEADER_NAME = 'x-vercel-protection-bypass';
const VERCEL_SET_BYPASS_COOKIE_HEADER_NAME = 'x-vercel-set-bypass-cookie';
const transientNavigationErrors = [
  'net::ERR_ABORTED',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_FAILED',
  'frame was detached',
];

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
  await page.context().setExtraHTTPHeaders({
    [VERCEL_BYPASS_HEADER_NAME]: bypassCookieValue,
    [VERCEL_SET_BYPASS_COOKIE_HEADER_NAME]: 'true',
  });
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

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await page.goto(url, {
        waitUntil: 'domcontentloaded',
        ...options,
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isTransient = transientNavigationErrors.some((fragment) => message.includes(fragment));
      if (!isTransient || attempt === 4) {
        throw error;
      }

      await page.waitForTimeout(1000 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
