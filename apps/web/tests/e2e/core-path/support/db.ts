/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import postgres, { type Sql } from 'postgres';

let client: Sql | null = null;

/**
 * The journeys read their evidence (spend, stop counts, tool journal, model prices) through one read-only database role
 * that can SELECT only those columns (README, "只读数据库角色"). It is NOT the application's DATABASE_URL.
 */
export function coreSql(): Sql {
  if (client) return client;
  const url = process.env.CORE_E2E_SPEND_DATABASE_URL?.trim();
  if (!url) throw new Error('Missing CORE_E2E_SPEND_DATABASE_URL (the read-only evidence role).');
  client = postgres(url, { max: 1, prepare: false, ssl: 'require', idle_timeout: 5, connect_timeout: 10 });
  return client;
}
