/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNTS, assertStagingUrl, emailFor, PRODUCTION_PROJECT_REF, randomPassword, STAGING_PROJECT_REF, topUpAmount }
  from '../e2e-core-path/seed-lib.mjs';

test('the seed accepts only the staging Supabase project', () => {
  assert.equal(assertStagingUrl(`https://${STAGING_PROJECT_REF}.supabase.co`), `https://${STAGING_PROJECT_REF}.supabase.co`);
  assert.throws(() => assertStagingUrl(`https://${PRODUCTION_PROJECT_REF}.supabase.co`), /production/);
  for (const bad of ['', 'not a url', 'http://' + STAGING_PROJECT_REF + '.supabase.co', `https://${STAGING_PROJECT_REF}.supabase.co:5432`,
    `https://${STAGING_PROJECT_REF}.supabase.co/rest/v1`, `https://user@${STAGING_PROJECT_REF}.supabase.co`,
    'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', `https://${STAGING_PROJECT_REF}.supabase.co.evil.test`]) {
    assert.throws(() => assertStagingUrl(bad), undefined, bad);
  }
});

test('accounts: two roles, no account is closed by the tests, addresses carry the operator domain only', () => {
  assert.deepEqual(Object.keys(ACCOUNTS).sort(), ['gold', 'pro']);
  assert.equal(ACCOUNTS.gold.level, 'gold');
  assert.equal(emailFor('gold', 'example.com'), 'core-e2e-gold@example.com');
  assert.throws(() => emailFor('admin', 'example.com'), /Unknown role/);
  assert.throws(() => emailFor('gold', 'no domain'), /domain/);
});

test('passwords are random and long; top-up never removes credits', () => {
  assert.notEqual(randomPassword(), randomPassword());
  assert.ok(randomPassword().length >= 30);
  assert.equal(topUpAmount(100, 6000), 5900);
  assert.equal(topUpAmount(9000, 6000), 0);
  assert.equal(topUpAmount(null, 100), 100);
});
