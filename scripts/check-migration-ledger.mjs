#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';

const LEGAL_MIGRATION_FILENAME = /^(?<number>\d{4})_(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

// These two already-applied migrations predate the ledger rule and must remain
// byte-for-byte untouched. No other duplicate number is permitted.
const HISTORICAL_DUPLICATE_ALLOWLIST = new Map([
  ['0018', new Set([
    '0018_payment_fulfillment_atomicity.sql',
    '0018_rls_text_flags_and_job_runs.sql',
  ])],
]);

export async function checkMigrationLedger(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrationsByNumber = new Map();
  const errors = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.sql')) {
      continue;
    }

    const match = LEGAL_MIGRATION_FILENAME.exec(entry.name);
    if (!match?.groups) {
      errors.push(`Malformed migration filename: ${entry.name}`);
      continue;
    }

    const files = migrationsByNumber.get(match.groups.number) ?? [];
    files.push(entry.name);
    migrationsByNumber.set(match.groups.number, files);
  }

  for (const [number, files] of migrationsByNumber) {
    if (files.length < 2) {
      continue;
    }

    const allowlisted = HISTORICAL_DUPLICATE_ALLOWLIST.get(number);
    const isExactHistoricalPair = allowlisted
      && files.length === allowlisted.size
      && files.every((file) => allowlisted.has(file));

    if (!isExactHistoricalPair) {
      errors.push(`Duplicate migration number ${number}: ${files.sort().join(', ')}`);
    }
  }

  return errors;
}

async function main() {
  const directory = path.resolve(process.argv[2] ?? 'packages/db/migrations');
  let errors;

  try {
    errors = await checkMigrationLedger(directory);
  } catch (error) {
    console.error(`Migration ledger check could not inspect the migration directory: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Migration ledger check failed: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Migration ledger check passed.');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
