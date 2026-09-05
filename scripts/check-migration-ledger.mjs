#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const LEGAL_MIGRATION_FILENAME = /^(?<number>\d{4})_(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;
const POST_BASELINE_START = 48;
const REQUIRED_POST_BASELINE_HIGHEST = 63;

// These two already-applied migrations predate the ledger rule and must remain
// byte-for-byte untouched. No other duplicate number is permitted.
const HISTORICAL_DUPLICATE_ALLOWLIST = new Map([
  ['0018', new Set([
    '0018_payment_fulfillment_atomicity.sql',
    '0018_rls_text_flags_and_job_runs.sql',
  ])],
]);

const FROZEN_HISTORICAL_MIGRATION_HASHES = new Map([
  ['0018_payment_fulfillment_atomicity.sql', '494d1f5b55d3a0cb2e7a1bdf291870bd402db36a9ff5abf15700f982c4245fd8'],
  ['0018_rls_text_flags_and_job_runs.sql', 'e8e4e3bd5aaf4ecec634229de40a8a591e8a31e7c693b59eb69f82f61a6fb0da'],
]);

export async function checkMigrationLedger(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrationsByNumber = new Map();
  const errors = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;

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
    if (files.length < 2) continue;

    const allowlisted = HISTORICAL_DUPLICATE_ALLOWLIST.get(number);
    const isExactHistoricalPair = allowlisted
      && files.length === allowlisted.size
      && files.every((file) => allowlisted.has(file));
    if (!isExactHistoricalPair) {
      errors.push(`Duplicate migration number ${number}: ${files.sort().join(', ')}`);
    }
  }

  for (const [file, expectedHash] of FROZEN_HISTORICAL_MIGRATION_HASHES) {
    let contents;
    try {
      contents = await readFile(path.join(directory, file));
    } catch {
      errors.push(`Missing frozen historical migration: ${file}`);
      continue;
    }

    const actualHash = createHash('sha256').update(contents).digest('hex');
    if (actualHash !== expectedHash) {
      errors.push(`Modified frozen historical migration: ${file}`);
    }
  }

  const postBaselineNumbers = [...migrationsByNumber.keys()]
    .map(Number)
    .filter((number) => number >= POST_BASELINE_START)
    .sort((left, right) => left - right);

  if (postBaselineNumbers.length > 0) {
    const highestNumber = Math.max(postBaselineNumbers.at(-1), REQUIRED_POST_BASELINE_HIGHEST);
    for (let number = POST_BASELINE_START; number <= highestNumber; number += 1) {
      const paddedNumber = String(number).padStart(4, '0');
      if (!migrationsByNumber.has(paddedNumber)) {
        errors.push(`Missing post-baseline migration number ${paddedNumber}`);
      }
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
    for (const error of errors) console.error(`Migration ledger check failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Migration ledger check passed.');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main();
