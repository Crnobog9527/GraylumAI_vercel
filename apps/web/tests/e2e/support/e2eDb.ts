/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';

import dotenv from 'dotenv';
import postgres, { type Sql } from 'postgres';

let sqlClient: Sql | null = null;

export function loadE2EEnv() {
  if (process.env.RELEASE_PREFLIGHT_ISOLATED === '1') return;
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  dotenv.config({ path: path.resolve(process.cwd(), 'apps/web/.env.local'), override: true });
}

export function getE2ESql() {
  loadE2EEnv();

  if (sqlClient) {
    return sqlClient;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL for E2E database fixtures.');
  }

  if (process.env.RELEASE_PREFLIGHT_ISOLATED === '1' && !/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/sim$/.test(databaseUrl)) {
    throw new Error('preflight requires its disposable loopback database');
  }
  sqlClient = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ssl: process.env.RELEASE_PREFLIGHT_ISOLATED === '1' ? false : 'require',
    idle_timeout: 5,
    connect_timeout: 10,
  });

  return sqlClient;
}
