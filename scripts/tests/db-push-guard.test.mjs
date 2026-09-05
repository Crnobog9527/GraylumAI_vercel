import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod, access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDatabaseTarget } from '../db-push-guard.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const guard = path.join(repositoryRoot, 'scripts/db-push-guard.mjs');
const fixtureProjectRef = 'abcdefghijklmnopqrst';
const validUrl = `postgresql://postgres@db.${fixtureProjectRef}.supabase.co:5432/postgres`;
const validPoolerUrl = `postgresql://postgres.${fixtureProjectRef}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const dbRequire = createRequire(path.join(repositoryRoot, 'packages/db/package.json'));
const dotenvConfig = dbRequire.resolve('dotenv/config');

test('derives the same project ref from supported direct and pooler URLs', () => {
  assert.equal(parseDatabaseTarget(validUrl), fixtureProjectRef);
  assert.equal(parseDatabaseTarget(validPoolerUrl), fixtureProjectRef);
});

test('rejects target-overriding connection query parameters', () => {
  assert.throws(() => parseDatabaseTarget(`${validUrl}?host=db.zyxwvutsrqponmlkjihg.supabase.co`), /must not override/);
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
  for (const key of Object.keys(process.env)) {
    if (/^(DOTENV_|NODE_OPTIONS$|NODE_PATH$)/i.test(key) && !(key in env)) delete childEnv[key];
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  return execFileSync(process.execPath, [guard], { cwd: repositoryRoot, env: childEnv, encoding: 'utf8', stdio: 'pipe' });
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
    assert.throws(() => runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: undefined }), (error) => /db:push blocked/.test(error.stderr));
    assert.equal(await wasInvoked(fixture.marker), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('real dotenv override can replace A with B, but the guard blocks it before downstream execution', async () => {
  const fixture = await fixtureRunner();
  const passwordA = randomUUID();
  const passwordB = randomUUID();
  const urlA = new URL(validUrl);
  const urlB = new URL(validUrl);
  urlA.password = passwordA;
  urlB.password = passwordB;
  urlB.hostname = 'db.zyxwvutsrqponmlkjihg.supabase.co';
  const targetA = urlA.href;
  const targetB = urlB.href;
  const dotenvFile = path.join(fixture.directory, '.env');
  const observation = path.join(fixture.directory, 'observed-url');
  try {
    await writeFile(dotenvFile, `DATABASE_URL=${targetB}\n`);
    // This is the installed dotenv/config resolved from Drizzle's own package.
    // It records its final URL to a temporary file; it never connects anywhere.
    await writeFile(fixture.runner, `#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nimport { writeFileSync } from 'node:fs';\ncreateRequire(import.meta.url)(${JSON.stringify(dotenvConfig)});\nwriteFileSync(${JSON.stringify(observation)}, process.env.DATABASE_URL);\nwriteFileSync(${JSON.stringify(fixture.marker)}, 'invoked');\n`);
    for (const override of ['true', 'false', '1']) {
      const attack = {
        PATH: process.env.PATH,
        DATABASE_URL: targetA,
        DB_PUSH_CONFIRM: fixtureProjectRef,
        NODE_ENV: 'test',
        DB_PUSH_TEST_RUNNER: fixture.runner,
        DOTENV_CONFIG_PATH: dotenvFile,
        DOTENV_CONFIG_OVERRIDE: override,
      };
      execFileSync(process.execPath, [fixture.runner], { env: attack, stdio: 'pipe' });
      assert.equal(await readFile(observation, 'utf8'), targetB);
      await rm(observation);
      await rm(fixture.marker);
      assert.throws(() => runGuard(attack), (error) => {
        assert.notEqual(error.status, 0);
        const output = `${error.stdout}${error.stderr}`;
        for (const sensitive of [targetA, targetB, passwordA, passwordB, dotenvFile]) {
          assert.equal(output.includes(sensitive), false);
        }
        return true;
      });
      assert.equal(await wasInvoked(fixture.marker), false);
      assert.equal(await wasInvoked(observation), false);
    }
    // With default dotenv semantics, an existing validated URL survives a
    // conflicting ordinary .env file, including one that sets override itself.
    await writeFile(dotenvFile, `DATABASE_URL=${targetB}\nDOTENV_CONFIG_OVERRIDE=true\n`);
    execFileSync(process.execPath, [fixture.runner], {
      cwd: fixture.directory,
      env: { PATH: process.env.PATH, DATABASE_URL: targetA }, stdio: 'pipe',
    });
    assert.equal(await readFile(observation, 'utf8'), targetA);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('blocks the entire dotenv and Node preload configuration surface before invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    for (const key of ['DOTENV_CONFIG_PATH', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_KEY', 'DOTENV_CONFIG_DOTENV_KEY', 'DOTENV_CONFIG_DEBUG', 'DOTENV_CONFIG_ENCODING', 'DOTENV_CONFIG_FUTURE', 'NODE_OPTIONS', 'NODE_PATH']) {
      assert.throws(() => runGuard({ DATABASE_URL: validUrl, DB_PUSH_CONFIRM: fixtureProjectRef, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, [key]: '' }));
      assert.equal(await wasInvoked(fixture.marker), false);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('blocks a wrong confirmation before downstream invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    assert.throws(() => runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: 'wrongprojectref000000' }), (error) => /db:push blocked/.test(error.stderr));
    assert.equal(await wasInvoked(fixture.marker), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('allows an exact confirmation to invoke the harmless injected runner', async () => {
  const fixture = await fixtureRunner();
  try {
    runGuard({ DATABASE_URL: validUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: fixtureProjectRef });
    assert.equal(await wasInvoked(fixture.marker), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('fails closed for malformed, unsupported, and ambiguous targets before downstream invocation', async () => {
  const fixture = await fixtureRunner();
  try {
    for (const databaseUrl of ['not a url', `mysql://user@db.${fixtureProjectRef}.supabase.co/database`, 'postgresql://postgres@db.example.test/postgres', 'postgresql://postgres@aws-0-us-east-1.pooler.supabase.com/postgres']) {
      assert.throws(() => runGuard({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', DB_PUSH_TEST_RUNNER: fixture.runner, DB_PUSH_CONFIRM: fixtureProjectRef }), (error) => /db:push blocked/.test(error.stderr));
      assert.equal(await wasInvoked(fixture.marker), false);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
