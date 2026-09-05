import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDatabaseTarget } from '../db-push-guard.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const guard = path.join(repositoryRoot, 'scripts/db-push-guard.mjs');
const validUrl = 'postgresql://postgres:secret@db.gvcpmcunmfrbxuwimxfa.supabase.co:5432/postgres';
const validPoolerUrl = 'postgresql://postgres.gvcpmcunmfrbxuwimxfa:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

test('derives the same project ref from supported direct and pooler URLs', () => {
  assert.equal(parseDatabaseTarget(validUrl), 'gvcpmcunmfrbxuwimxfa');
  assert.equal(parseDatabaseTarget(validPoolerUrl), 'gvcpmcunmfrbxuwimxfa');
});

async function fixtureRunner() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'graylum-db-push-'));
  const marker = path.join(directory, 'downstream-invoked');
  const runner = path.join(directory, 'runner.mjs');
  await writeFile(runner, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`);
  await chmod(runner, 0o755);
  return { directory, marker, runner };
}

function runGuard(env) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    }
  }

  return execFileSync(process.execPath, [guard], {
    cwd: repositoryRoot,
    env: childEnv,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function wasInvoked(marker) {
  try {
    await access(marker);
    return true;
  } catch {
    return false;
  }
}

test('blocks a valid target when confirmation is missing before downstream invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    assert.throws(
      () => runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: undefined }),
      (error) => /db:push blocked/.test(error.stderr),
    );
    assert.equal(await wasInvoked(fixture.marker), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('blocks a wrong confirmation before downstream invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    assert.throws(
      () => runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: 'wrongprojectref000000' }),
      (error) => /db:push blocked/.test(error.stderr),
    );
    assert.equal(await wasInvoked(fixture.marker), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('allows an exact confirmation to invoke the harmless injected runner', async () => {
  const fixture = await fixtureRunner();
  try {
    runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: 'gvcpmcunmfrbxuwimxfa' });
    assert.equal(await wasInvoked(fixture.marker), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('fails closed for malformed, unsupported, and ambiguous targets before downstream invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    for (const databaseUrl of [
      'not a url',
      'mysql://user:secret@db.gvcpmcunmfrbxuwimxfa.supabase.co/database',
      'postgresql://postgres:secret@db.example.test/postgres',
      'postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com/postgres',
    ]) {
      assert.throws(
        () => runGuard({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: 'gvcpmcunmfrbxuwimxfa' }),
        (error) => /db:push blocked/.test(error.stderr),
      );
      assert.equal(await wasInvoked(fixture.marker), false);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
