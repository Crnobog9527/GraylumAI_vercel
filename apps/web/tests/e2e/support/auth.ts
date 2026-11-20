/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { getE2ESql } from './e2eDb';

export type E2ERole = 'user' | 'admin';

const authDirectory = process.env.RELEASE_PREFLIGHT_ISOLATED === '1'
  ? (process.env.RELEASE_PREFLIGHT_AUTH_DIR ?? '') : path.join(__dirname, '../.auth');
if (!authDirectory) throw new Error('isolated preflight requires its temporary auth directory');

export const authStatePaths = {
  user: path.join(authDirectory, 'user.json'),
  admin: path.join(authDirectory, 'admin.json'),
} as const;

export function getCredentials(role: E2ERole) {
  if (role === 'admin') {
    return {
      email: process.env.E2E_ADMIN_EMAIL ?? '',
      password: process.env.E2E_ADMIN_PASSWORD ?? '',
    };
  }

  return {
    email: process.env.E2E_TEST_EMAIL ?? '',
    password: process.env.E2E_TEST_PASSWORD ?? '',
  };
}

export function hasCredentials(role: E2ERole) {
  const { email, password } = getCredentials(role);
  return Boolean(email && password);
}

export async function ensureAuthStateDirectory() {
  await mkdir(authDirectory, { recursive: true });
}

export async function ensureMaintenanceModeDisabled(sql = getE2ESql()) {
  const rows = await sql<{ value: unknown }[]>`select value from system_settings where key = 'maintenance_mode'`;
  const value = rows[0]?.value;
  if (value !== undefined && value !== false && value !== 'false') {
    throw new Error('maintenance_mode is enabled or invalid; E2E setup will not modify it');
  }
}

export async function waitForLoginFormReady(page: Page) {
  await page.waitForSelector('#email, input[type="email"], input[name="email"]', {
    state: 'visible',
  });
  await page.waitForSelector('#password, input[type="password"], input[name="password"]', {
    state: 'visible',
  });

  try {
    await page.waitForResponse(
      (response) =>
        response.url().includes('/api/trpc/settings.getSystemSettings') &&
        response.request().method() === 'GET',
      { timeout: 10000 },
    );
  } catch {
    await page.waitForTimeout(1000);
  }
}

export async function clearBrowserAuthState(page: Page) {
  await page.context().clearCookies();
  await page.evaluate(async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    if (typeof indexedDB.databases !== 'function') {
      return;
    }

    const databases = await indexedDB.databases();
    await Promise.all(
      (databases ?? []).map(({ name }) => new Promise<void>((resolve) => {
        if (!name) {
          resolve();
          return;
        }

        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }))
    );
  });
  await page.context().clearCookies();
}
