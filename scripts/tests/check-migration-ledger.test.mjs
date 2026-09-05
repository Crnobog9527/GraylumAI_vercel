import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('rejects a duplicate migration number after the historical baseline', async () => {
  const fixture = await copiedMigrations();
  try {
    await writeFile(path.join(fixture, '0063_duplicate_fixture.sql'), '-- test fixture\n');
    assert.throws(
      () => runChecker(fixture),
      (error) => /Duplicate migration number 0063/.test(error.stderr),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('rejects malformed migration-like SQL filenames', async () => {
  const fixture = await copiedMigrations();
  try {
    await writeFile(path.join(fixture, '0064-no-separator.sql'), '-- test fixture\n');
    assert.throws(
      () => runChecker(fixture),
      (error) => /Malformed migration filename/.test(error.stderr),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
