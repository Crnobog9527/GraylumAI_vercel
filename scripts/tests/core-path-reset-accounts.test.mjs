/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOutsideRepo, assertStaging, emailFor, resetAccounts } from '../loadtest/reset-accounts.mjs';

const env = { SUPABASE_URL: 'https://staging.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture',
  LOADTEST_ALLOWED_HOST: 'staging.example.invalid', LOADTEST_EMAIL_TEMPLATE: 'load{n}@example.test' };

test('templates, host allow-list and output location are enforced', () => {
  assert.equal(emailFor('a{n}@x.test', 7), 'a007@x.test');
  assert.throws(() => emailFor('nope@x.test', 1), /needs \{n\}/);
  assert.throws(() => assertStaging('https://other.example.invalid', 'staging.example.invalid'), /refusing/);
  assert.throws(() => assertStaging('https://staging.example.invalid', undefined), /refusing/);
  assert.throws(() => assertOutsideRepo(join(process.cwd(), 'accounts.json')), /outside the repository/);
  assert.doesNotThrow(() => assertOutsideRepo(join(tmpdir(), 'accounts.json')));
});

test('creates the requested accounts, bans the previous batch and writes credentials only to the 0600 file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reset-'));
  const previous = join(dir, 'previous.json');
  const out = join(dir, 'next.json');
  (await import('node:fs')).writeFileSync(previous, JSON.stringify({ accounts: [{ id: 'old-1' }, { id: 'old-2' }] }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const failed = init.method === 'POST' && calls.filter(c => c.method === 'POST').length === 3;
    return { ok: !failed, status: failed ? 422 : 200, json: async () => failed ? { error_code: 'email_exists' } : { id: `id-${calls.length}` } };
  };
  const logs = [];
  const { tally, accounts } = await resetAccounts({ env, fetchImpl, from: 5, count: 4, out, banPrevious: previous, log: line => logs.push(line) });
  assert.deepEqual(tally, { banned: 2, created: 3, failed: 1 });
  assert.equal(accounts.length, 3);
  assert.deepEqual(calls.filter(c => c.method === 'PUT').map(c => c.url.split('/').pop()), ['old-1', 'old-2']);
  assert.equal(calls.filter(c => c.method === 'POST')[0].body.email, 'load005@example.test');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).accounts.length, 3);
  assert.ok(logs.join('\n').includes('email_exists'));
  assert.ok(!logs.join('\n').includes('sb_secret_fixture'), 'the key is never printed');
});
