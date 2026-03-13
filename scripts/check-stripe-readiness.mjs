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
const envLocalPath = path.join(rootDir, '.env.local');

if (existsSync(envLocalPath)) {
  loadDotenv({ path: envLocalPath, override: false });
}

const requiredEnvKeys = [
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_APP_URL',
];

function printSection(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function checkEnv() {
  const missing = requiredEnvKeys.filter((key) => !process.env[key]);

  printSection('Environment');
  for (const key of requiredEnvKeys) {
    console.log(`- ${key}: ${process.env[key] ? 'set' : 'missing'}`);
  }

  return missing;
}

async function checkDatabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  printSection('Database');

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
    console.log('- Data source: Supabase service role');
  } else if (databaseUrl) {
    const client = new PgClient({ connectionString: databaseUrl });
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
      console.log('- Data source: DATABASE_URL');
    } finally {
      await client.end();
    }
  } else {
    console.log('- Skipped: missing Supabase service-role credentials and DATABASE_URL');
    return {
      skipped: true,
      missingCreditPackages: [],
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

  console.log(`- Active credit packages: ${(creditPackages ?? []).length}`);
  console.log(`- Active paid membership plans: ${(membershipPlans ?? []).filter((plan) => plan.level !== 'free').length}`);
  console.log(`- Credit packages missing Stripe Price ID: ${missingCreditPackages.length}`);
  console.log(`- Membership plans missing monthly/yearly Price IDs: ${missingMembershipPlans.length}`);

  if (missingCreditPackages.length > 0) {
    console.log('\n  Credit packages missing Stripe Price ID:');
    for (const pkg of missingCreditPackages) {
      console.log(`  - ${pkg.name} (${pkg.id})`);
    }
  }

  if (missingMembershipPlans.length > 0) {
    console.log('\n  Membership plans missing Stripe Price IDs:');
    for (const plan of missingMembershipPlans) {
      const missing = [
        plan.missingMonthly ? 'monthly' : null,
        plan.missingYearly ? 'yearly' : null,
      ].filter(Boolean).join(', ');
      console.log(`  - ${plan.name} (${plan.id}) missing: ${missing}`);
    }
  }

  return {
    skipped: false,
    missingCreditPackages,
    missingMembershipPlans,
  };
}

async function main() {
  console.log('Stripe readiness check');
  console.log('======================');

  const missingEnv = checkEnv();
  const dbStatus = await checkDatabase();

  const ready =
    missingEnv.length === 0 &&
    !dbStatus.skipped &&
    dbStatus.missingCreditPackages.length === 0 &&
    dbStatus.missingMembershipPlans.length === 0;

  printSection('Result');
  if (ready) {
    console.log('Stripe checkout is ready to enable.');
    process.exit(0);
  }

  console.log('Stripe checkout is NOT ready to enable.');
  process.exit(1);
}

main().catch((error) => {
  console.error('\nStripe readiness check failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
