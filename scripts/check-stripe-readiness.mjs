#!/usr/bin/env node
/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { Client as PgClient } from 'pg';
import { createClient } from '@supabase/supabase-js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvLocalPath = path.join(rootDir, '.env.local');
const defaultExpectedAppHost = 'staging.graylum.com';
const knownProductionHostFragments = ['app.graylum.com'];
const productionWordPattern = /(^|[-_.])prod(uction)?($|[-_.])/i;

function writeStdout(message = '') {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = '') {
  process.stderr.write(`${message}\n`);
}

const requiredEnvKeys = [
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_APP_URL',
];

class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

function parseArgs(argv) {
  const options = {
    confirmStaging: false,
    envPath: null,
    help: false,
    json: false,
    requireTestMode: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--confirm-staging') {
      options.confirmStaging = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--require-test-mode') {
      options.requireTestMode = true;
    } else if (arg === '--env') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--env requires a file path');
      }
      options.envPath = value;
      index += 1;
    } else if (arg.startsWith('--env=')) {
      options.envPath = arg.slice('--env='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  writeStdout('Stripe checkout readiness check.');
  writeStdout('');
  writeStdout('Usage:');
  writeStdout('  node scripts/check-stripe-readiness.mjs');
  writeStdout('  node scripts/check-stripe-readiness.mjs --env .env.staging.local --confirm-staging --require-test-mode');
  writeStdout('');
  writeStdout('Options:');
  writeStdout('  --env <path>          Load a specific env file instead of default .env.local.');
  writeStdout('  --confirm-staging     Refuse production-like app hosts before staging checks.');
  writeStdout('  --require-test-mode   Require Stripe test-mode keys and test-mode Price objects.');
  writeStdout('  --json                Print sanitized JSON output.');
  writeStdout('  --help, -h            Show this help.');
  writeStdout('');
  writeStdout('This script prints only variable presence, safe mode labels, counts, and masked Stripe identifiers.');
}

function loadEnvFile(envPath) {
  const resolvedPath = envPath ? path.resolve(rootDir, envPath) : defaultEnvLocalPath;
  if (!existsSync(resolvedPath)) {
    if (envPath) {
      throw new Error('Env file not found');
    }
    return {
      loaded: false,
      source: '.env.local',
    };
  }

  const result = loadDotenv({ path: resolvedPath, override: false, quiet: true });
  if (result.error) {
    throw new Error('Failed to load env file');
  }

  return {
    loaded: true,
    source: envPath || '.env.local',
  };
}

function printSection(title) {
  writeStdout(`\n${title}`);
  writeStdout('-'.repeat(title.length));
}

function getStripeKeyMode(value, expectedPrefix) {
  if (!value) {
    return 'missing';
  }

  if (value.startsWith(`${expectedPrefix}_test_`)) {
    return 'test';
  }

  if (value.startsWith(`${expectedPrefix}_live_`)) {
    return 'live';
  }

  return 'unknown';
}

function maskIdentifier(value) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function maskKnownStripeIdentifiers(message) {
  if (!message) {
    return null;
  }

  return message.replace(
    /\b(?:cs_(?:test|live)|sub|in|cus|price|pi|ch|prod)_[A-Za-z0-9_]+\b/g,
    (value) => maskIdentifier(value) ?? value,
  );
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new SafetyError(`${label} is not a valid URL`);
  }
}

function hostHasProductionSignal(hostname) {
  const normalized = hostname.toLowerCase();
  return knownProductionHostFragments.some((fragment) => normalized.includes(fragment))
    || productionWordPattern.test(normalized);
}

function getSafeEnvironmentMetadata(options, envLoadStatus) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
    ? parseUrl(process.env.NEXT_PUBLIC_APP_URL, 'NEXT_PUBLIC_APP_URL')
    : null;
  const appHost = appUrl?.hostname.toLowerCase() ?? null;
  const expectedAppHost = process.env.EXPECTED_APP_HOST || defaultExpectedAppHost;
  const productionSignals = [];

  if (appHost && hostHasProductionSignal(appHost)) {
    productionSignals.push('app host has a production-like host');
  }

  if (options.confirmStaging) {
    if (!appHost) {
      productionSignals.push('NEXT_PUBLIC_APP_URL is required for confirmed staging checks');
    } else if (!appHost.includes(expectedAppHost.toLowerCase())) {
      productionSignals.push(`app host does not include expected staging host ${expectedAppHost}`);
    }
  }

  return {
    appHost,
    expectedAppHost,
    loadedEnvFile: envLoadStatus.loaded,
    envSource: envLoadStatus.source,
    productionLikeTargetDetected: productionSignals.length > 0,
    productionSignals,
  };
}

function getStripeModeStatus(options) {
  const secretKeyMode = getStripeKeyMode(process.env.STRIPE_SECRET_KEY, 'sk');
  const publishableKeyMode = getStripeKeyMode(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'pk');
  const errors = [];
  const warnings = [];

  if (
    secretKeyMode !== 'missing' &&
    publishableKeyMode !== 'missing' &&
    secretKeyMode !== 'unknown' &&
    publishableKeyMode !== 'unknown' &&
    secretKeyMode !== publishableKeyMode
  ) {
    errors.push('Stripe secret and publishable keys use different modes');
  }

  if (options.requireTestMode) {
    if (secretKeyMode === 'live' || publishableKeyMode === 'live') {
      errors.push('Confirmed staging checks require Stripe test-mode keys');
    }

    if (secretKeyMode === 'unknown' || publishableKeyMode === 'unknown') {
      errors.push('Confirmed staging checks require recognizable Stripe test-mode keys');
    }
  }

  if (!options.requireTestMode && (secretKeyMode === 'live' || publishableKeyMode === 'live')) {
    warnings.push('Stripe live-mode key detected; only use this for production checks');
  }

  return {
    secretKeyMode,
    publishableKeyMode,
    webhookSecretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    errors,
    warnings,
  };
}

function checkEnv(options, environment, stripeMode) {
  const missing = requiredEnvKeys.filter((key) => !process.env[key]);

  if (!options.json) {
    printSection('Environment');
    writeStdout(`- Env source: ${environment.envSource} (${environment.loadedEnvFile ? 'loaded' : 'not found'})`);
    writeStdout(`- App host: ${environment.appHost ?? 'missing'}`);
    for (const key of requiredEnvKeys) {
      writeStdout(`- ${key}: ${process.env[key] ? 'set' : 'missing'}`);
    }
    writeStdout(`- Stripe secret mode: ${stripeMode.secretKeyMode}`);
    writeStdout(`- Stripe publishable mode: ${stripeMode.publishableKeyMode}`);
  }

  return missing;
}

async function checkDatabase(options) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  if (!options.json) {
    printSection('Database');
  }

  let creditPackages = [];
  let membershipPlans = [];

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [{ data: creditData, error: creditError }, { data: planData, error: planError }] = await Promise.all([
      supabase
        .from('credit_packages')
        .select('id, name, active, stripe_price_id')
        .eq('active', 'true')
        .order('sort_order', { ascending: true }),
      supabase
        .from('membership_plans')
        .select('id, name, level, is_active, stripe_monthly_price_id, stripe_yearly_price_id')
        .eq('is_active', 'true')
        .order('sort_order', { ascending: true }),
    ]);

    if (creditError) {
      throw new Error(`Failed to query credit packages: ${creditError.message}`);
    }

    if (planError) {
      throw new Error(`Failed to query membership plans: ${planError.message}`);
    }

    creditPackages = creditData ?? [];
    membershipPlans = planData ?? [];
    if (!options.json) {
      writeStdout('- Data source: Supabase service role');
    }
  } else if (databaseUrl) {
    const client = new PgClient({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });
    await client.connect();

    try {
      const [creditResult, planResult] = await Promise.all([
        client.query(
          `select id, name, active, stripe_price_id
           from credit_packages
           where active = 'true'
           order by sort_order asc`,
        ),
        client.query(
          `select id, name, level, is_active, stripe_monthly_price_id, stripe_yearly_price_id
           from membership_plans
           where is_active = 'true'
           order by sort_order asc`,
        ),
      ]);

      creditPackages = creditResult.rows;
      membershipPlans = planResult.rows;
      if (!options.json) {
        writeStdout('- Data source: DATABASE_URL');
      }
    } finally {
      await client.end();
    }
  } else {
    if (!options.json) {
      writeStdout('- Skipped: missing Supabase service-role credentials and DATABASE_URL');
    }
    return {
      skipped: true,
      creditPackages: [],
      missingCreditPackages: [],
      membershipPlans: [],
      missingMembershipPlans: [],
    };
  }

  const missingCreditPackages = (creditPackages ?? []).filter((pkg) => !pkg.stripe_price_id);
  const missingMembershipPlans = (membershipPlans ?? [])
    .filter((plan) => plan.level !== 'free')
    .map((plan) => ({
      ...plan,
      missingMonthly: !plan.stripe_monthly_price_id,
      missingYearly: !plan.stripe_yearly_price_id,
    }))
    .filter((plan) => plan.missingMonthly || plan.missingYearly);

  if (!options.json) {
    writeStdout(`- Active credit packages: ${(creditPackages ?? []).length}`);
    writeStdout(`- Active paid membership plans: ${(membershipPlans ?? []).filter((plan) => plan.level !== 'free').length}`);
    writeStdout(`- Credit packages missing Stripe Price ID: ${missingCreditPackages.length}`);
    writeStdout(`- Membership plans missing monthly/yearly Price IDs: ${missingMembershipPlans.length}`);
  }

  if (!options.json && missingCreditPackages.length > 0) {
    writeStdout('\n  Credit packages missing Stripe Price ID:');
    for (const pkg of missingCreditPackages) {
      writeStdout(`  - ${pkg.name} (${pkg.id})`);
    }
  }

  if (!options.json && missingMembershipPlans.length > 0) {
    writeStdout('\n  Membership plans missing Stripe Price IDs:');
    for (const plan of missingMembershipPlans) {
      const missing = [
        plan.missingMonthly ? 'monthly' : null,
        plan.missingYearly ? 'yearly' : null,
      ].filter(Boolean).join(', ');
      writeStdout(`  - ${plan.name} (${plan.id}) missing: ${missing}`);
    }
  }

  return {
    skipped: false,
    creditPackages,
    missingCreditPackages,
    membershipPlans,
    missingMembershipPlans,
  };
}

function collectStripePriceReferences(dbStatus) {
  const references = [];

  for (const pkg of dbStatus.creditPackages ?? []) {
    if (pkg.stripe_price_id) {
      references.push({
        ownerType: 'credit_package',
        ownerName: pkg.name,
        ownerId: pkg.id,
        priceId: pkg.stripe_price_id,
        usage: 'one_time',
      });
    }
  }

  for (const plan of dbStatus.membershipPlans ?? []) {
    if (plan.level === 'free') {
      continue;
    }

    if (plan.stripe_monthly_price_id) {
      references.push({
        ownerType: 'membership_plan',
        ownerName: plan.name,
        ownerId: plan.id,
        priceId: plan.stripe_monthly_price_id,
        usage: 'monthly',
      });
    }

    if (plan.stripe_yearly_price_id) {
      references.push({
        ownerType: 'membership_plan',
        ownerName: plan.name,
        ownerId: plan.id,
        priceId: plan.stripe_yearly_price_id,
        usage: 'yearly',
      });
    }
  }

  return references;
}

async function checkStripePrices(options, dbStatus) {
  const references = collectStripePriceReferences(dbStatus);
  const result = {
    checked: false,
    totalReferences: references.length,
    uniquePriceIds: new Set(references.map((item) => item.priceId)).size,
    missingOrUnreadable: [],
    inactive: [],
    liveModeInTestCheck: [],
  };

  if (!process.env.STRIPE_SECRET_KEY || references.length === 0) {
    return result;
  }

  result.checked = true;

  const uniqueReferences = new Map();
  for (const reference of references) {
    if (!uniqueReferences.has(reference.priceId)) {
      uniqueReferences.set(reference.priceId, []);
    }
    uniqueReferences.get(reference.priceId).push(reference);
  }

  await Promise.all([...uniqueReferences.entries()].map(async ([priceId, owners]) => {
    try {
      const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        const message = typeof payload?.error?.message === 'string'
          ? payload.error.message
          : `Stripe API returned HTTP ${response.status}`;
        throw new Error(message);
      }

      const price = payload;
      if (!price.active) {
        result.inactive.push({
          priceId: maskIdentifier(priceId),
          owners: owners.map((owner) => `${owner.ownerType}:${owner.ownerName}:${owner.usage}`),
        });
      }

      if (options.requireTestMode && price.livemode) {
        result.liveModeInTestCheck.push({
          priceId: maskIdentifier(priceId),
          owners: owners.map((owner) => `${owner.ownerType}:${owner.ownerName}:${owner.usage}`),
        });
      }
    } catch (error) {
      result.missingOrUnreadable.push({
        priceId: maskIdentifier(priceId),
        owners: owners.map((owner) => `${owner.ownerType}:${owner.ownerName}:${owner.usage}`),
        message: maskKnownStripeIdentifiers(
          error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        ),
      });
    }
  }));

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const envLoadStatus = loadEnvFile(options.envPath);
  const environment = getSafeEnvironmentMetadata(options, envLoadStatus);
  const stripeMode = getStripeModeStatus(options);

  if (environment.productionLikeTargetDetected) {
    throw new SafetyError(`Refusing unsafe target: ${environment.productionSignals.join('; ')}`);
  }

  if (!options.json) {
    writeStdout('Stripe readiness check');
    writeStdout('======================');
  }

  const missingEnv = checkEnv(options, environment, stripeMode);
  const dbStatus = await checkDatabase(options);
  const stripePriceStatus = await checkStripePrices(options, dbStatus);

  const ready =
    missingEnv.length === 0 &&
    stripeMode.errors.length === 0 &&
    !dbStatus.skipped &&
    dbStatus.missingCreditPackages.length === 0 &&
    dbStatus.missingMembershipPlans.length === 0 &&
    stripePriceStatus.missingOrUnreadable.length === 0 &&
    stripePriceStatus.inactive.length === 0 &&
    stripePriceStatus.liveModeInTestCheck.length === 0;

  const report = {
    ready,
    environment,
    env: {
      required: Object.fromEntries(requiredEnvKeys.map((key) => [key, Boolean(process.env[key])])),
      missing: missingEnv,
    },
    stripeMode,
    database: {
      skipped: dbStatus.skipped,
      activeCreditPackages: dbStatus.creditPackages?.length ?? 0,
      activePaidMembershipPlans: (dbStatus.membershipPlans ?? []).filter((plan) => plan.level !== 'free').length,
      missingCreditPackagePriceIds: dbStatus.missingCreditPackages.length,
      missingMembershipPlanPriceIds: dbStatus.missingMembershipPlans.length,
    },
    stripePrices: {
      ...stripePriceStatus,
      uniquePriceIds: stripePriceStatus.uniquePriceIds,
    },
  };

  if (options.json) {
    writeStdout(JSON.stringify(report, null, 2));
  } else {
    printSection('Stripe Price catalog');
    writeStdout(`- Checked Stripe API: ${stripePriceStatus.checked ? 'yes' : 'no'}`);
    writeStdout(`- Price references: ${stripePriceStatus.totalReferences}`);
    writeStdout(`- Unique Price IDs: ${stripePriceStatus.uniquePriceIds}`);
    writeStdout(`- Missing/unreadable Price IDs: ${stripePriceStatus.missingOrUnreadable.length}`);
    writeStdout(`- Inactive Price IDs: ${stripePriceStatus.inactive.length}`);
    writeStdout(`- Live-mode IDs during test-mode check: ${stripePriceStatus.liveModeInTestCheck.length}`);

    for (const warning of stripeMode.warnings) {
      writeStdout(`- Warning: ${warning}`);
    }

    printSection('Result');
  }

  if (ready) {
    if (!options.json) {
      writeStdout('Stripe checkout is ready to enable.');
    }
    process.exit(0);
  }

  if (!options.json) {
    writeStdout('Stripe checkout is NOT ready to enable.');
  }
  process.exit(1);
}

main().catch((error) => {
  writeStderr('\nStripe readiness check failed.');
  writeStderr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
