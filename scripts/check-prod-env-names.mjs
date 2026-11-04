#!/usr/bin/env node
/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// Offline check of the Vercel production variable NAMES against the build-day
// list (docs/launch/tasks/REL-1-BUILD-PREP.md steps 24-26, 30e1, 38, 41a).
// It reads a text file of names only (one per line; anything after the first
// whitespace or "=" is ignored and never printed). It touches no network,
// no Vercel, no database.
//
//   node scripts/check-prod-env-names.mjs --phase build|smoke|public <names-file>

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PHASES = ['build', 'smoke', 'public'];

// Steps 24 and 25: set before the deployment that points at the new database.
export const REQUIRED_ALWAYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'OPENING_GRANT_HMAC_KEYS',
  'CRON_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_AUTH_APP_URL',
  'APP_ENV',
  'NEXT_PUBLIC_APP_ENV',
  'TURN_DATABASE_HOST',
  'V3_RUNTIME_PRODUCTION_PROJECT_ID',
  'V3_RUNTIME_PRODUCTION_DATABASE_HOST',
  'V3_RUNTIME_PRODUCTION_ENABLED',
  'STRIPE_CARD_RECONCILIATION_MODE',
  'PAY_PRODUCTION_CARD_CHECKOUT_ENABLED',
  'PAY_PRODUCTION_WALLET_CHECKOUT_ENABLED',
  'NEXT_PUBLIC_HCAPTCHA_SITEKEY',
  'NEXT_PUBLIC_TERMLY_WEBSITE_UUID',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'PAYMENT_NOTICE_FROM',
  'NEXT_PUBLIC_COMPOSER_REFERENCES',
  'NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION',
  'NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION',
  'NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION',
];

// Step 26: must never exist on the production project. A trailing "*" is a prefix.
export const FORBIDDEN_ALWAYS = [
  'V3_RUNTIME_STAGING_*',
  'WAFFO_TEST_*',
  'LOADTEST_*',
  'LANDING_PREVIEW_FEATURES',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'PAYMENT_NOTICE_TEST_RECIPIENTS',
  'EXPECTED_APP_HOST',
  'E2E_*',
];

// The four Waffo production variables (step 24) are not checked: they only exist after the S-8 review, which may be after launch.

// Only a warning: step 25a needs a staging A/B acceptance first, so the variable
// may legitimately be missing until that is signed off.
export const WARN_MISSING_LATER = ['LANDING_PROMO_OFFERS'];

function matches(pattern, name) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

// Accepts "NAME", "NAME=value", "export NAME=value", quoted names, "NAME: value" and `vercel env ls` rows.
// Everything after the name is dropped unread; lines that give no name are only counted, never echoed.
export function parseNamesDetailed(text) {
  const names = new Set();
  let unparsed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '').replace(/^["'`]+/, '');
    if (!line || line.startsWith('#')) continue;
    const name = line.split(/[\s=:,"'`]/)[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    else unparsed += 1;
  }
  return { names, unparsed };
}

export function parseNames(text) {
  return parseNamesDetailed(text).names;
}

export function checkNames(names, phase) {
  if (!PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES.join(', ')}`);
  const errors = [];
  const warnings = [];
  for (const name of REQUIRED_ALWAYS) {
    if (!names.has(name)) errors.push(`missing required variable ${name}`);
  }
  for (const pattern of FORBIDDEN_ALWAYS) {
    for (const name of names) {
      if (matches(pattern, name)) errors.push(`variable ${name} must not exist on production (${pattern})`);
    }
  }
  // Step 25: not set at build time. Step 30e1: set after the coach package is published.
  if (phase === 'build' && names.has('PUBLISH_MONITOR_HANDBOOK_PACKAGE')) {
    errors.push('PUBLISH_MONITOR_HANDBOOK_PACKAGE must not be set before the coach Skill is published (step 30e1)');
  }
  if (phase !== 'build' && !names.has('PUBLISH_MONITOR_HANDBOOK_PACKAGE')) {
    errors.push('missing PUBLISH_MONITOR_HANDBOOK_PACKAGE (step 30e1; weekly review waits without it)');
  }
  // Steps 25 and 38: indexing stays off until public opening.
  if (phase === 'public' && !names.has('SITE_INDEXING')) errors.push('missing SITE_INDEXING (step 38)');
  if (phase !== 'public' && names.has('SITE_INDEXING')) {
    errors.push('SITE_INDEXING must not be set before public opening (step 38)');
  }
  if (phase !== 'build') {
    for (const name of WARN_MISSING_LATER) {
      if (!names.has(name)) warnings.push(`${name} is not set yet (step 25a needs the staging A/B acceptance first)`);
    }
  }
  return { errors, warnings };
}

function main(argv) {
  const args = argv.slice(2);
  const phaseAt = args.indexOf('--phase');
  const phase = phaseAt >= 0 ? args[phaseAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--phase');
  if (!phase || !file) {
    process.stderr.write('usage: check-prod-env-names.mjs --phase build|smoke|public <names-file>\n');
    return 2;
  }
  if (!PHASES.includes(phase)) {
    process.stderr.write(`phase must be one of ${PHASES.join(', ')}\n`);
    return 2;
  }
  const { names, unparsed } = parseNamesDetailed(readFileSync(file, 'utf8'));
  const { errors, warnings } = checkNames(names, phase);
  if (unparsed > 0) warnings.push(`${unparsed} line(s) had no readable variable name and were skipped`);
  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
  for (const e of errors) process.stdout.write(`FAIL ${e}\n`);
  process.stdout.write(errors.length === 0 ? `PASS production variable names (${phase})\n` : `${errors.length} problem(s)\n`);
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv));
