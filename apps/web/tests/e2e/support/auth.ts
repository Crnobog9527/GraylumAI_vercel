/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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
