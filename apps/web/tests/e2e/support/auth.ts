/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

export type E2ERole = 'user' | 'admin';

const authDirectory = path.join(__dirname, '../.auth');

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

export async function ensureMaintenanceModeDisabled() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { error } = await adminClient
    .from('system_settings')
    .update({ value: false })
    .eq('key', 'maintenance_mode');

  if (error) {
    throw new Error(`Failed to disable maintenance mode for E2E setup: ${error.message}`);
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
