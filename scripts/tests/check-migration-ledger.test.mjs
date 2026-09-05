import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const checker = path.join(repositoryRoot, 'scripts/check-migration-ledger.mjs');
const repositoryMigrations = path.join(repositoryRoot, 'packages/db/migrations');
const ciWorkflow = path.join(repositoryRoot, '.github/workflows/ci.yml');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

async function migrationFixture({ trustedChecker = true, trustedMigrations = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graylum-migration-ledger-'));
  const migrations = path.join(root, 'packages/db/migrations');
  if (trustedChecker) {
    const fixtureChecker = path.join(root, 'scripts/check-migration-ledger.mjs');
    await mkdir(path.dirname(fixtureChecker), { recursive: true });
    await cp(checker, fixtureChecker);
  }
  if (trustedMigrations) {
    await mkdir(path.dirname(migrations), { recursive: true });
    await cp(repositoryMigrations, migrations, { recursive: true });
  } else {
    await writeFile(path.join(root, 'README.md'), 'base without migration evidence\n');
  }

  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Migration Fixture']);
  git(root, ['config', 'user.email', 'migration-fixture@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'trusted base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);

  if (!trustedMigrations) {
    await mkdir(path.dirname(migrations), { recursive: true });
    await cp(repositoryMigrations, migrations, { recursive: true });
  }

  const eventPath = path.join(root, 'github-event.json');
  return { baseSha, eventPath, migrations, root };
}

function runChecker(fixture, baseSha = fixture.baseSha) {
  const event = baseSha === null
    ? { pull_request: { base: {} } }
    : { pull_request: { base: { sha: baseSha } } };
  writeFileSync(fixture.eventPath, `${JSON.stringify(event)}\n`);
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: fixture.eventPath,
  };
  delete env.MIGRATION_BASE_SHA;

  return execFileSync(process.execPath, [checker, fixture.migrations], {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
    stdio: 'pipe',
  });
}

async function withFixture(assertion, options) {
  const fixture = await migrationFixture(options);
  try {
    await assertion(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('accepts the current migration ledger against its exact base commit', async () => {
  await withFixture(async (fixture) => {
    assert.match(runChecker(fixture), /Migration ledger check passed/);
  }, { trustedChecker: false });
});

test('bootstrap workflow authenticates this checker and rejects a no-op replacement', async () => {
  const workflow = await readFile(ciWorkflow, 'utf8');
  const pinnedHash = workflow.match(/expected_checker_sha='(?<hash>[0-9a-f]{64})'/)?.groups?.hash;
  assert.ok(pinnedHash, 'bootstrap checker SHA-256 pin must be present');
  const checkerHash = createHash('sha256').update(await readFile(checker)).digest('hex');
  const noOpHash = createHash('sha256').update('process.exit(0);\n').digest('hex');
  assert.equal(checkerHash, pinnedHash);
  assert.notEqual(noOpHash, pinnedHash);
  assert.match(workflow, /git ls-files --stage -- scripts\/check-migration-ledger\.mjs/);
  assert.match(workflow, /\[ -L scripts\/check-migration-ledger\.mjs \]/);
  assert.match(workflow, /100644\|100755/);
});

test('accepts only the exact historical 0018 pair already present in the base', async () => {
  await withFixture(async (fixture) => {
    const pair = (await readdir(fixture.migrations)).filter((file) => file.startsWith('0018_')).sort();
    assert.deepEqual(pair, [
      '0018_payment_fulfillment_atomicity.sql',
      '0018_rls_text_flags_and_job_runs.sql',
    ]);
    assert.match(runChecker(fixture), /Migration ledger check passed/);
  });
});

test('rejects a byte change to a base-existing migration', async () => {
  await withFixture(async (fixture) => {
    await appendFile(path.join(fixture.migrations, '0018_payment_fulfillment_atomicity.sql'), '\n-- candidate edit\n');
    assert.throws(
      () => runChecker(fixture),
      (error) => /Base-existing migration differs from exact base: .*0018_payment_fulfillment_atomicity\.sql/.test(error.stderr),
    );
  });
});

test('candidate-local matching hashes cannot authenticate a modified base migration', async () => {
  await withFixture(async (fixture) => {
    const migration = path.join(fixture.migrations, '0047_subscription_fulfillment_service_role_grants.sql');
    await appendFile(migration, '\n-- candidate edit\n');
    const candidateHash = createHash('sha256').update(await readFile(migration)).digest('hex');
    await mkdir(path.join(fixture.root, 'scripts'), { recursive: true });
    await writeFile(
      path.join(fixture.root, 'scripts/candidate-migration-hashes.json'),
      `${JSON.stringify({ '0047_subscription_fulfillment_service_role_grants.sql': candidateHash })}\n`,
    );

    assert.throws(
      () => runChecker(fixture),
      (error) => /Base-existing migration differs from exact base: .*0047_subscription_fulfillment_service_role_grants\.sql/.test(error.stderr),
    );
  });
});

test('rejects changing the successor checker after it exists in the exact base', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.root, 'scripts/check-migration-ledger.mjs'), 'process.exit(0);\n');
    assert.throws(
      () => runChecker(fixture),
      (error) => /Migration ledger checker differs from exact base/.test(error.stderr),
    );
  });
});

test('rejects deleting the successor checker after it exists in the exact base', async () => {
  await withFixture(async (fixture) => {
    await rm(path.join(fixture.root, 'scripts/check-migration-ledger.mjs'));
    assert.throws(
      () => runChecker(fixture),
      (error) => /Migration ledger checker differs from exact base/.test(error.stderr),
    );
  });
});

test('rejects deletion of a base-existing migration', async () => {
  await withFixture(async (fixture) => {
    await rm(path.join(fixture.migrations, '0001_ai_billing_tables.sql'));
    assert.throws(
      () => runChecker(fixture),
      (error) => /Missing base-existing migration: 0001_ai_billing_tables\.sql/.test(error.stderr),
    );
  });
});

test('rejects rename or replacement of a base-existing migration', async () => {
  await withFixture(async (fixture) => {
    await rename(
      path.join(fixture.migrations, '0063_bill_1_reconciliation_select_contract.sql'),
      path.join(fixture.migrations, '0064_replacement.sql'),
    );
    assert.throws(
      () => runChecker(fixture),
      (error) => /Missing base-existing migration: 0063_bill_1_reconciliation_select_contract\.sql/.test(error.stderr),
    );
  });
});

test('rejects a duplicate migration number after the historical baseline', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.migrations, '0063_duplicate_fixture.sql'), '-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Duplicate migration number 0063/.test(error.stderr));
  });
});

test('rejects a gap in the post-baseline migration sequence', async () => {
  await withFixture(async (fixture) => {
    await rm(path.join(fixture.migrations, '0062_skill_1a_db_publish_contract.sql'));
    assert.throws(
      () => runChecker(fixture),
      (error) => /Missing post-baseline migration number 0062/.test(error.stderr),
    );
  });
});

test('rejects malformed migration-like SQL filenames', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.migrations, '0064-no-separator.sql'), '-- test fixture\n');
    assert.throws(() => runChecker(fixture), (error) => /Malformed migration filename/.test(error.stderr));
  });
});

test('rejects a migration-like symlink instead of ignoring it', async () => {
  await withFixture(async (fixture) => {
    await symlink(
      '0063_bill_1_reconciliation_select_contract.sql',
      path.join(fixture.migrations, '0064_future.sql'),
    );
    assert.throws(
      () => runChecker(fixture),
      (error) => /Migration path must be a regular file: 0064_future\.sql/.test(error.stderr),
    );
  });
});

test('rejects nested migration entries instead of ignoring them', async () => {
  await withFixture(async (fixture) => {
    const nested = path.join(fixture.migrations, 'nested');
    await mkdir(nested);
    await writeFile(path.join(nested, '0064_hidden.sql'), '-- hidden migration fixture\n');
    assert.throws(
      () => runChecker(fixture),
      (error) => /Nested migration directory is not allowed: nested/.test(error.stderr),
    );
  });
});

test('allows a future migration only at the next sequential number', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.migrations, '0064_future.sql'), '-- future migration fixture\n');
    assert.match(runChecker(fixture), /Migration ledger check passed/);
  });
});

test('fails closed when the exact base SHA is missing or cannot be resolved', async () => {
  await withFixture(async (fixture) => {
    assert.throws(
      () => runChecker(fixture, null),
      (error) => /Missing or invalid exact migration base SHA/.test(error.stderr),
    );
    assert.throws(
      () => runChecker(fixture, 'f'.repeat(40)),
      (error) => /Could not resolve exact migration base commit/.test(error.stderr),
    );
  });
});

test('fails closed when the exact base contains no migration evidence', async () => {
  await withFixture(async (fixture) => {
    assert.throws(
      () => runChecker(fixture),
      (error) => /Exact base commit contains no trusted migration evidence/.test(error.stderr),
    );
  }, { trustedMigrations: false });
});
