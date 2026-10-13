/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reads the staging service-role key into memory only. First choice is the logged-in Supabase CLI;
// fallback is ~/.graylum/secrets/supabase-staging.env. Nothing is written to disk or printed.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  assertStagingServiceKey, assertStagingSupabaseUrl, RefusalError, STAGING_PROJECT_REF,
} from './guards.mjs';

const execFileAsync = promisify(execFile);

export function pickServiceKey(apiKeys) {
  if (!Array.isArray(apiKeys)) return null;
  const legacy = apiKeys.find(entry => entry?.name === 'service_role' && typeof entry.api_key === 'string');
  if (legacy) return legacy.api_key;
  const secret = apiKeys.find(entry => entry?.type === 'secret' && /^sb_secret_[A-Za-z0-9_-]+$/
    .test(entry.api_key ?? ''));
  return secret ? secret.api_key : null;
}

export async function keyFromCli({ run = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await run('supabase', ['projects', 'api-keys', '--project-ref', STAGING_PROJECT_REF,
      '-o', 'json'], { timeout: 30_000, maxBuffer: 1024 * 1024 }));
  } catch {
    return null; // CLI missing, not logged in, or no access; stderr is not echoed.
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  return pickServiceKey(parsed);
}

export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

export async function keyFromEnvFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const values = parseEnvFile(text);
  const url = values.SUPABASE_URL || values.NEXT_PUBLIC_SUPABASE_URL;
  if (url) assertStagingSupabaseUrl(url);
  return values.SUPABASE_SERVICE_ROLE_KEY || values.SUPABASE_SECRET_KEY || null;
}

export async function loadServiceKey({ envFile, run } = {}) {
  const fromCli = await keyFromCli({ run });
  const key = fromCli ?? await keyFromEnvFile(envFile);
  if (!key) {
    throw new RefusalError('读不到测试站管理密钥：Supabase CLI 未登录或没有权限，' +
      `也没有 ${envFile}。请按 docs/runbooks/STAGING_TEST_LOGIN.md 处理。`);
  }
  return { key: assertStagingServiceKey(key), source: fromCli ? 'supabase-cli' : 'env-file' };
}
