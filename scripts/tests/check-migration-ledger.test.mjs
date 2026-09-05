import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const checker = path.join(repositoryRoot, 'scripts/check-migration-ledger.mjs');
const migrations = path.join(repositoryRoot, 'packages/db/migrations');

async function copiedMigrations() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'graylum-migration-ledger-'));
  await cp(migrations, fixture, { recursive: true });
  return fixture;
}

function runChecker(directory) {
  return execFileSync(process.execPath, [checker, directory], { encoding: 'utf8', stdio: 'pipe' });
}

test('accepts the current migration ledger and its exact historical 0018 pair', () => {
  assert.match(runChecker(migrations), /Migration ledger check passed/);
});

test('rejects a byte change to an allowlisted historical migration', async () => {
  const fixture = await copiedMigrations();
  try {
    await appendFile(path.join(fixture, '0018_payment_fulfillment_atomicity.sql'), '\n-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Modified frozen migration: 0018_payment_fulfillment_atomicity\.sql/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects a byte change to a non-allowlisted applied migration', async () => {
  const fixture = await copiedMigrations();
  try {
    await appendFile(path.join(fixture, '0047_subscription_fulfillment_service_role_grants.sql'), '\n-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Modified frozen migration: 0047_subscription_fulfillment_service_role_grants\.sql/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects a duplicate migration number after the historical baseline', async () => {
  const fixture = await copiedMigrations();
  try {
    await writeFile(path.join(fixture, '0063_duplicate_fixture.sql'), '-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Duplicate migration number 0063/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects a gap in the post-baseline migration sequence', async () => {
  const fixture = await copiedMigrations();
  try {
    await rm(path.join(fixture, '0062_skill_1a_db_publish_contract.sql'));
    assert.throws(() => runChecker(fixture), (error) => /Missing post-baseline migration number 0062/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects deletion of the committed post-baseline high-water migration', async () => {
  const fixture = await copiedMigrations();
  try {
    await rm(path.join(fixture, '0063_bill_1_reconciliation_select_contract.sql'));
    assert.throws(() => runChecker(fixture), (error) => /Missing post-baseline migration number 0063/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects deletion of the entire committed post-baseline segment', async () => {
  const fixture = await copiedMigrations();
  try {
    for (const file of await readdir(fixture)) {
      if (/^00(?:4[89]|5\d|6[0-3])_/.test(file)) await rm(path.join(fixture, file));
    }
    assert.throws(() => runChecker(fixture), (error) => /Missing post-baseline migration number 0048/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects malformed migration-like SQL filenames', async () => {
  const fixture = await copiedMigrations();
  try {
    await writeFile(path.join(fixture, '0064-no-separator.sql'), '-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Malformed migration filename/.test(error.stderr));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
