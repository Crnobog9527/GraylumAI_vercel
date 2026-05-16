#!/usr/bin/env node
/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Client as PgClient } from 'pg';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredEnvKeys = ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_APP_URL'];
const optionalEnvKeys = ['EXPECTED_SUPABASE_PROJECT_REF', 'EXPECTED_APP_HOST'];
const defaultExpectedAppHost = 'graylumai-staging.vercel.app';
const knownProductionHostFragments = ['app.graylum.com'];
const productionWordPattern = /(^|[-_.])prod(uction)?($|[-_.])/i;

const functionTargets = [
  'atomic_pre_deduct',
  'atomic_settle',
  'atomic_refund',
  'atomic_abort_settle',
  'atomic_finalize_ai_success',
  'atomic_finalize_ai_failure',
  'atomic_finalize_ai_abort',
  'atomic_apply_invitation_rebate',
  'atomic_apply_credit_ledger_entry',
  'atomic_claim_invitation_code',
  'atomic_fulfill_credit_package',
  'atomic_fulfill_membership_invoice',
  'validate_invitation_code',
  'is_admin',
];

const tableTargets = [
  'conversations',
  'token_stats',
  'ai_models',
  'membership_plans',
  'credit_packages',
  'system_settings',
  'profiles',
  'credit_transactions',
  'billing_history',
  'ai_usage_logs',
];

const roles = ['anon', 'authenticated', 'service_role'];

const expectedPolicies = new Map([
  ['conversations', ['conversations_select_own', 'conversations_insert_own', 'conversations_update_own']],
  ['token_stats', ['users_own_token_stats_select']],
  ['ai_models', ['authenticated_active_ai_models_select']],
  ['membership_plans', ['membership_plans_select_active_public']],
  ['credit_packages', ['credit_packages_select_active_public']],
  ['system_settings', ['system_settings_select_public_user_facing']],
  ['profiles', ['profiles_select_own']],
  ['credit_transactions', ['credit_transactions_select_own']],
]);

const allowedClientWritePrivileges = new Map([
  ['authenticated:conversations', new Set(['INSERT', 'UPDATE'])],
]);

function writeStdout(message = '') {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = '') {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    confirmStaging: false,
    envPath: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--confirm-staging') {
      options.confirmStaging = true;
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
  writeStdout('Read-only staging DB readiness verification.');
  writeStdout('');
  writeStdout('Usage:');
  writeStdout('  node scripts/check-staging-db-readiness.mjs --env <staging-env-file> --confirm-staging');
  writeStdout('  node scripts/check-staging-db-readiness.mjs --env <staging-env-file> --confirm-staging --json');
  writeStdout('');
  writeStdout('Options:');
  writeStdout('  --env <path>          Load environment variables from a local env file without printing values.');
  writeStdout('  --confirm-staging     Required before any database connection is attempted.');
  writeStdout('  --json                Print sanitized JSON output.');
  writeStdout('  --help, -h            Show this help.');
  writeStdout('');
  writeStdout('Exit codes:');
  writeStdout('  0  Readiness is acceptable for the documented baseline.');
  writeStdout('  1  Readiness gaps were found.');
  writeStdout('  2  Safety violation, production-like target, missing env, or query failure.');
}

function loadEnvFile(envPath) {
  if (!envPath) {
    return null;
  }

  const resolvedPath = path.resolve(rootDir, envPath);
  if (!existsSync(resolvedPath)) {
    throw new Error('Env file not found');
  }

  const result = loadDotenv({ path: resolvedPath, override: false, quiet: true });
  if (result.error) {
    throw new Error('Failed to load env file');
  }

  return true;
}

function getRequiredEnvStatus() {
  return Object.fromEntries(requiredEnvKeys.map((key) => [key, Boolean(process.env[key])]));
}

function requireEnv() {
  const missing = requiredEnvKeys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new SafetyError(`Missing required env keys: ${missing.join(', ')}`);
  }
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

function getSupabaseProjectRef(supabaseUrl) {
  const hostname = supabaseUrl.hostname.toLowerCase();
  const [firstSegment] = hostname.split('.');
  return firstSegment || null;
}

function getSafeEnvironmentMetadata() {
  const appUrl = parseUrl(process.env.NEXT_PUBLIC_APP_URL, 'NEXT_PUBLIC_APP_URL');
  const supabaseUrl = parseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = parseUrl(process.env.DATABASE_URL, 'DATABASE_URL');

  const expectedAppHost = process.env.EXPECTED_APP_HOST || defaultExpectedAppHost;
  const expectedProjectRef = process.env.EXPECTED_SUPABASE_PROJECT_REF || null;
  const appHost = appUrl.hostname.toLowerCase();
  const supabaseHost = supabaseUrl.hostname.toLowerCase();
  const dbHost = databaseUrl.hostname.toLowerCase();
  const supabaseProjectRef = getSupabaseProjectRef(supabaseUrl);

  const productionSignals = [];
  for (const [label, host] of [
    ['app host', appHost],
    ['Supabase host', supabaseHost],
    ['DB host', dbHost],
  ]) {
    if (hostHasProductionSignal(host)) {
      productionSignals.push(`${label} has a production-like host`);
    }
  }

  if (!appHost.includes(expectedAppHost.toLowerCase())) {
    productionSignals.push(`app host does not include expected staging host ${expectedAppHost}`);
  }

  if (!isSupabaseLikeHost(supabaseHost)) {
    productionSignals.push('Supabase host is not a recognized Supabase host');
  }

  if (!isSupabaseLikeHost(dbHost)) {
    productionSignals.push('DB host is not a recognized Supabase host or pooler');
  }

  if (expectedProjectRef && supabaseProjectRef !== expectedProjectRef) {
    productionSignals.push('Supabase project ref does not match EXPECTED_SUPABASE_PROJECT_REF');
  }

  return {
    appHost,
    supabaseHost,
    supabaseProjectRef,
    dbHost,
    expectedAppHost,
    expectedProjectRefConfigured: Boolean(expectedProjectRef),
    optionalEnvConfigured: Object.fromEntries(optionalEnvKeys.map((key) => [key, Boolean(process.env[key])])),
    requiredEnvConfigured: getRequiredEnvStatus(),
    productionLikeTargetDetected: productionSignals.length > 0,
    productionSignals,
  };
}

function isSupabaseLikeHost(hostname) {
  return hostname.endsWith('.supabase.co')
    || hostname.endsWith('.supabase.com')
    || hostname.includes('.pooler.supabase.com')
    || hostname.includes('supabase');
}

class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

function ensureReadOnlySql(sql) {
  const normalized = sql.trim().toLowerCase();
  const allowedPattern = /^(begin\s+read\s+only|rollback\b|show\s+|select\s+|with\s+)/;
  if (!allowedPattern.test(normalized)) {
    throw new SafetyError('Refusing to execute a non-read-only SQL statement');
  }
}

async function safeQuery(client, sql, params = []) {
  ensureReadOnlySql(sql);
  return client.query(sql, params);
}

async function collectDatabaseReadiness(databaseUrl) {
  const client = new PgClient({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  await client.connect();

  try {
    await safeQuery(client, 'begin read only');
    const readOnlyResult = await safeQuery(client, 'show transaction_read_only');
    const transactionReadOnly = readOnlyResult.rows[0]?.transaction_read_only;

    if (transactionReadOnly !== 'on') {
      throw new SafetyError('transaction_read_only was not enabled');
    }

    const functionsResult = await safeQuery(client, functionQuery, [functionTargets]);
    const tablesResult = await safeQuery(client, tableQuery, [tableTargets]);
    const policiesResult = await safeQuery(client, policyQuery, [tableTargets]);
    const grantsResult = await safeQuery(client, grantQuery, [tableTargets, roles]);
    const countsResult = await safeQuery(client, readinessCountsQuery);

    return {
      transactionReadOnly,
      functions: summarizeFunctions(functionsResult.rows),
      tables: summarizeTables(tablesResult.rows, policiesResult.rows, grantsResult.rows),
      counts: countsResult.rows[0],
    };
  } finally {
    try {
      await safeQuery(client, 'rollback');
    } finally {
      await client.end();
    }
  }
}

const functionQuery = `
  with targets(name) as (select unnest($1::text[])),
  funcs as (
    select
      n.nspname as schema_name,
      p.proname as function_name,
      p.prosecdef as security_definer,
      coalesce(p.proconfig, array[]::text[]) as config,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])
  )
  select
    t.name as target,
    count(f.function_name)::int as overload_count,
    bool_or(coalesce(f.security_definer, false)) as security_definer,
    bool_or(exists (select 1 from unnest(f.config) c where c like 'search_path=%')) as search_path_configured,
    bool_or(coalesce(f.anon_execute, false)) as anon_execute,
    bool_or(coalesce(f.authenticated_execute, false)) as authenticated_execute,
    bool_or(coalesce(f.service_role_execute, false)) as service_role_execute
  from targets t
  left join funcs f on f.function_name = t.name
  group by t.name
  order by t.name
`;

const tableQuery = `
  with targets(name) as (select unnest($1::text[]))
  select
    t.name as table_name,
    c.oid is not null as exists,
    coalesce(c.relrowsecurity, false) as rls_enabled
  from targets t
  left join pg_class c
    on c.relname = t.name
   and c.relnamespace = 'public'::regnamespace
  order by t.name
`;

const policyQuery = `
  select tablename, policyname, cmd, roles
  from pg_policies
  where schemaname = 'public' and tablename = any($1::text[])
  order by tablename, policyname
`;

const grantQuery = `
  select
    table_name,
    grantee,
    string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = any($1::text[])
    and grantee = any($2::text[])
  group by table_name, grantee
  order by table_name, grantee
`;

const readinessCountsQuery = `
  select
    (select count(*)::int from public.ai_models where is_active = 'true') as active_ai_models,
    (select count(*)::int from public.membership_plans where is_active = 'true') as active_membership_plans,
    (select count(*)::int from public.credit_packages where active = 'true') as active_credit_packages,
    (select count(*)::int from public.system_settings) as system_settings,
    (
      select count(*)::int
      from public.system_settings
      where key ilike '%billing%'
        or key ilike '%stripe%'
        or key ilike '%credit%'
        or key ilike '%price%'
        or key ilike '%token%'
    ) as billing_related_system_settings,
    (select count(*)::int from public.ai_models where api_key is not null) as ai_models_with_api_key
`;

function summarizeFunctions(rows) {
  return rows.map((row) => ({
    name: row.target,
    exists: Number(row.overload_count) > 0,
    securityDefiner: Boolean(row.security_definer),
    searchPathConfigured: Boolean(row.search_path_configured),
    grants: {
      anonExecute: Boolean(row.anon_execute),
      authenticatedExecute: Boolean(row.authenticated_execute),
      serviceRoleExecute: Boolean(row.service_role_execute),
    },
  }));
}

function summarizeTables(tableRows, policyRows, grantRows) {
  const policiesByTable = groupBy(policyRows, 'tablename');
  const grantsByTable = groupBy(grantRows, 'table_name');

  return tableRows.map((row) => {
    const policies = (policiesByTable.get(row.table_name) ?? []).map((policy) => ({
      name: policy.policyname,
      command: policy.cmd,
      roles: String(policy.roles ?? '').replace(/[{}]/g, '').split(',').filter(Boolean),
    }));
    const grants = Object.fromEntries(
      roles.map((role) => {
        const match = (grantsByTable.get(row.table_name) ?? []).find((grant) => grant.grantee === role);
        const privileges = match?.privileges ? match.privileges.split(',').filter(Boolean) : [];
        return [role, privileges];
      }),
    );

    return {
      name: row.table_name,
      exists: Boolean(row.exists),
      rlsEnabled: Boolean(row.rls_enabled),
      policyNames: policies.map((policy) => policy.name),
      policies,
      grants,
    };
  });
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!grouped.has(value)) {
      grouped.set(value, []);
    }
    grouped.get(value).push(row);
  }
  return grouped;
}

function buildDriftSummary(readiness, environment) {
  const missingFunctions = readiness.functions
    .filter((fn) => !fn.exists)
    .map((fn) => fn.name);

  const missingPolicies = [];
  for (const table of readiness.tables) {
    for (const expectedPolicyName of expectedPolicies.get(table.name) ?? []) {
      if (!table.policyNames.includes(expectedPolicyName)) {
        missingPolicies.push(`${table.name}.${expectedPolicyName}`);
      }
    }
  }

  const rlsDisabledTables = readiness.tables
    .filter((table) => table.exists && !table.rlsEnabled)
    .map((table) => table.name);

  const unsafeGrants = findUnsafeGrants(readiness.tables);
  const missingSeedCounts = findMissingSeedCounts(readiness.counts);

  return {
    productionSafetyViolation: environment.productionLikeTargetDetected,
    requiredFunctionsMissing: missingFunctions,
    rlsDisabledTables,
    missingPolicies,
    unsafeGrants,
    missingSeedCounts,
  };
}

function findUnsafeGrants(tables) {
  const findings = [];
  const reviewOnlyPrivileges = new Set(['REFERENCES', 'TRIGGER', 'TRUNCATE']);
  const writePrivileges = new Set(['INSERT', 'UPDATE', 'DELETE']);

  for (const table of tables) {
    for (const role of ['anon', 'authenticated']) {
      const privileges = table.grants[role] ?? [];

      for (const privilege of privileges) {
        const allowedWrites = allowedClientWritePrivileges.get(`${role}:${table.name}`) ?? new Set();
        if (writePrivileges.has(privilege) && !allowedWrites.has(privilege)) {
          findings.push(`${role} has ${privilege} on ${table.name}`);
        }
        if (reviewOnlyPrivileges.has(privilege)) {
          findings.push(`${role} has ${privilege} on ${table.name}`);
        }
      }
    }
  }

  return findings;
}

function findMissingSeedCounts(counts) {
  const findings = [];
  if (Number(counts.active_ai_models) <= 0) {
    findings.push('active_ai_models is 0');
  }
  if (Number(counts.active_membership_plans) <= 0) {
    findings.push('active_membership_plans is 0');
  }
  if (Number(counts.active_credit_packages) <= 0) {
    findings.push('active_credit_packages is 0');
  }
  if (Number(counts.system_settings) <= 0) {
    findings.push('system_settings is 0');
  }
  if (Number(counts.billing_related_system_settings) <= 0) {
    findings.push('billing_related_system_settings is 0');
  }
  return findings;
}

function isReady(driftSummary) {
  return !driftSummary.productionSafetyViolation
    && driftSummary.requiredFunctionsMissing.length === 0
    && driftSummary.rlsDisabledTables.length === 0
    && driftSummary.missingPolicies.length === 0
    && driftSummary.unsafeGrants.length === 0
    && driftSummary.missingSeedCounts.length === 0;
}

function printHumanReport(report) {
  writeStdout('Staging DB readiness check');
  writeStdout('==========================');
  writeStdout('');
  writeStdout('Environment safety');
  writeStdout(`- app host: ${report.environment.appHost}`);
  writeStdout(`- Supabase host: ${report.environment.supabaseHost}`);
  writeStdout(`- Supabase project ref: ${report.environment.supabaseProjectRef ?? 'unknown'}`);
  writeStdout(`- DB host: ${report.environment.dbHost}`);
  writeStdout(`- production-like target detected: ${yesNo(report.environment.productionLikeTargetDetected)}`);
  if (report.environment.productionSignals.length > 0) {
    for (const signal of report.environment.productionSignals) {
      writeStdout(`  - ${signal}`);
    }
  }
  writeStdout('');
  writeStdout('Read-only guard');
  writeStdout(`- transaction_read_only: ${report.database.transactionReadOnly}`);
  writeStdout('- rollback: attempted in all paths after DB connection');
  writeStdout('');
  writeStdout('Function readiness');
  const presentFunctions = report.database.functions.filter((fn) => fn.exists).length;
  writeStdout(`- present: ${presentFunctions}/${report.database.functions.length}`);
  writeStdout(`- missing: ${listOrNone(report.drift.requiredFunctionsMissing)}`);
  writeStdout('');
  writeStdout('RLS / policy readiness');
  writeStdout(`- tables with RLS disabled: ${listOrNone(report.drift.rlsDisabledTables)}`);
  writeStdout(`- missing expected policies: ${listOrNone(report.drift.missingPolicies)}`);
  writeStdout('');
  writeStdout('Grant review');
  writeStdout(`- client-role grants to review: ${report.drift.unsafeGrants.length}`);
  for (const finding of report.drift.unsafeGrants.slice(0, 20)) {
    writeStdout(`  - ${finding}`);
  }
  if (report.drift.unsafeGrants.length > 20) {
    writeStdout(`  - ... ${report.drift.unsafeGrants.length - 20} more`);
  }
  writeStdout('');
  writeStdout('Seed/readiness counts');
  writeStdout(`- active ai_models: ${report.database.counts.active_ai_models}`);
  writeStdout(`- active membership_plans: ${report.database.counts.active_membership_plans}`);
  writeStdout(`- active credit_packages: ${report.database.counts.active_credit_packages}`);
  writeStdout(`- system_settings: ${report.database.counts.system_settings}`);
  writeStdout(`- billing-related system_settings: ${report.database.counts.billing_related_system_settings}`);
  writeStdout(`- ai_models rows with api_key non-null: ${report.database.counts.ai_models_with_api_key}`);
  writeStdout('');
  writeStdout('Readiness result');
  writeStdout(`- ${report.ready ? 'PASS' : 'GAPS_FOUND'}`);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function listOrNone(values) {
  return values.length > 0 ? values.join(', ') : 'none';
}

function printJsonReport(report) {
  writeStdout(JSON.stringify(report, null, 2));
}

function redactReportForJson(report) {
  return {
    ready: report.ready,
    environment: report.environment,
    database: {
      transactionReadOnly: report.database.transactionReadOnly,
      functions: report.database.functions,
      tables: report.database.tables.map((table) => ({
        name: table.name,
        exists: table.exists,
        rlsEnabled: table.rlsEnabled,
        policyNames: table.policyNames,
        grants: table.grants,
      })),
      counts: report.database.counts,
    },
    drift: report.drift,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  const loadedEnvPath = loadEnvFile(options.envPath);

  if (!options.confirmStaging) {
    throw new SafetyError('Missing --confirm-staging; refusing to connect to the database');
  }

  requireEnv();
  const environment = getSafeEnvironmentMetadata();
  environment.loadedEnvFile = Boolean(loadedEnvPath);

  if (environment.productionLikeTargetDetected) {
    const report = {
      ready: false,
      environment,
      database: null,
      drift: {
        productionSafetyViolation: true,
        requiredFunctionsMissing: [],
        rlsDisabledTables: [],
        missingPolicies: [],
        unsafeGrants: [],
        missingSeedCounts: [],
      },
    };
    if (options.json) {
      printJsonReport(report);
    } else {
      writeStderr('Safety violation: production-like target detected.');
      for (const signal of environment.productionSignals) {
        writeStderr(`- ${signal}`);
      }
    }
    return 2;
  }

  const database = await collectDatabaseReadiness(process.env.DATABASE_URL);
  const drift = buildDriftSummary({ functions: database.functions, tables: database.tables, counts: database.counts }, environment);
  const ready = isReady(drift);
  const report = {
    ready,
    environment,
    database,
    drift,
  };

  if (options.json) {
    printJsonReport(redactReportForJson(report));
  } else {
    printHumanReport(report);
  }

  return ready ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    if (error instanceof SafetyError) {
      writeStderr(`Safety violation: ${error.message}`);
      process.exitCode = 2;
      return;
    }

    writeStderr(`Readiness check failed: ${error.message}`);
    process.exitCode = 2;
  });
