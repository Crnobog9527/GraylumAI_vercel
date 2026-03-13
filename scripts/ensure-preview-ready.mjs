/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

function parseArgs(argv) {
  const parsed = {
    previewUrl: '',
    bypassCookie: '',
    adminStatePath: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--preview-url') {
      parsed.previewUrl = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--bypass-cookie') {
      parsed.bypassCookie = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--admin-state') {
      parsed.adminStatePath = argv[index + 1] ?? parsed.adminStatePath;
      index += 1;
    }
  }

  return parsed;
}

function resolveAdminStatePath(adminStatePath) {
  const candidates = [
    adminStatePath,
    'tests/e2e/.auth/admin.json',
    'apps/web/tests/e2e/.auth/admin.json',
  ].filter(Boolean);

  const resolved = candidates
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));

  if (!resolved) {
    throw new Error(`Unable to find admin storage state. Tried: ${candidates.join(', ')}`);
  }

  return resolved;
}

function assertRequired(value, label) {
  if (!value) {
    throw new Error(`Missing required argument: ${label}`);
  }
}

async function applyBypass(context, previewUrl, bypassCookie) {
  const hostname = new URL(previewUrl).hostname;
  await context.setExtraHTTPHeaders({
    'x-vercel-protection-bypass': bypassCookie,
    'x-vercel-set-bypass-cookie': 'true',
  });
  await context.addCookies([
    {
      name: '_vercel_jwt',
      value: bypassCookie,
      domain: hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

async function ensureMaintenanceDisabled(page) {
  const maintenanceSwitch = page.getByTestId('admin-setting-maintenance_mode');
  const saveAllButton = page.getByTestId('admin-settings-save-all');

  await maintenanceSwitch.waitFor({ state: 'visible', timeout: 15000 });
  const enabled = (await maintenanceSwitch.getAttribute('data-state')) === 'checked';

  if (!enabled) {
    console.log('maintenance_mode already disabled');
    return;
  }

  console.log('maintenance_mode enabled; restoring to false');
  await maintenanceSwitch.click();
  await saveAllButton.click();
  await saveAllButton.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2500);
}

async function verifyPublicLoginAccessible(previewUrl, bypassCookie) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: previewUrl });
  try {
    await applyBypass(context, previewUrl, bypassCookie);
    const page = await context.newPage();
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/maintenance')) {
      throw new Error(`Preview still redirects public login to maintenance: ${page.url()}`);
    }
    console.log(`public login remains accessible at ${page.url()}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const { previewUrl, bypassCookie, adminStatePath } = parseArgs(process.argv.slice(2));
  assertRequired(previewUrl, '--preview-url');
  assertRequired(bypassCookie, '--bypass-cookie');
  const resolvedAdminStatePath = resolveAdminStatePath(adminStatePath);

  const browser = await chromium.launch({ headless: true });

  try {
      const context = await browser.newContext({
        baseURL: previewUrl,
        storageState: resolvedAdminStatePath,
      });

    try {
      await applyBypass(context, previewUrl, bypassCookie);
      const page = await context.newPage();
      await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });

      if (!page.url().includes('/admin/settings')) {
        throw new Error(`Expected /admin/settings but landed on ${page.url()}`);
      }

      await ensureMaintenanceDisabled(page);
    } finally {
      await context.close();
    }

    await verifyPublicLoginAccessible(previewUrl, bypassCookie);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
