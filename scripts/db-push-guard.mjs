#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const DIRECT_DATABASE_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const POOLED_DATABASE_HOST = /^(?:aws|aws-[a-z0-9-]+)\.pooler\.supabase\.com$/;

export function parseDatabaseTarget(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid supported PostgreSQL URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw new Error('DATABASE_URL must be a supported PostgreSQL URL.');
  }

  for (const parameter of ['host', 'port', 'user', 'password', 'database']) {
    if (parsed.searchParams.has(parameter)) {
      throw new Error('DATABASE_URL must not override its target through query parameters.');
    }
  }

  const hostname = parsed.hostname.toLowerCase();
  const directMatch = DIRECT_DATABASE_HOST.exec(hostname);
  if (directMatch) return directMatch[1];

  if (POOLED_DATABASE_HOST.test(hostname)) {
    const poolerMatch = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(parsed.username));
    if (poolerMatch) return poolerMatch[1];
  }

  throw new Error('DATABASE_URL target is unsupported or cannot be uniquely identified.');
}

function fail(message) {
  console.error(`db:push blocked: ${message}`);
  process.exitCode = 1;
}

export function runDbPush({ env = process.env, spawn = spawnSync } = {}) {
  let actualRef;
  try {
    actualRef = parseDatabaseTarget(env.DATABASE_URL);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'DATABASE_URL could not be parsed.');
    return false;
  }

  if (env.DB_PUSH_CONFIRM !== actualRef) {
    fail('set DB_PUSH_CONFIRM to the exact database project ref derived from DATABASE_URL.');
    return false;
  }

  const testRunner = env.DB_PUSH_TEST_RUNNER;
  if (testRunner && env.NODE_ENV !== 'test') {
    fail('DB_PUSH_TEST_RUNNER is only available when NODE_ENV=test.');
    return false;
  }

  const command = testRunner ?? 'pnpm';
  const args = testRunner
    ? ['push', '--config=packages/db/drizzle.config.ts']
    : ['exec', 'drizzle-kit', 'push', '--config=packages/db/drizzle.config.ts'];
  const result = spawn(command, args, { stdio: 'inherit', env });
  if (result.error) {
    fail(`could not start downstream drizzle push: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) runDbPush();
