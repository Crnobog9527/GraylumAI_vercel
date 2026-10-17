#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PAY-STRIPE-MP: membership catalog for the Stripe TEST sandbox (staging). Not for production
// (production: scripts/stripe-mp-live-catalog.mjs).
//
//   MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-sandbox-catalog.mjs plan    read-only: what exists / is missing
//   MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-sandbox-catalog.mjs apply   create only the missing objects
//   MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-sandbox-catalog.mjs sql     print staging mapping SQL to stdout
//     (committed as scripts/pay-stripe-mp/staging-catalog.sql; checks and rollback live next to it)
//   MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-sandbox-catalog.mjs sql-packs   staging credit-pack SQL
//     (committed as scripts/pay-stripe-mp/staging-packs.sql; checks and rollback live next to it)
//
// The key is read only from ~/.graylum/secrets/stripe-test.env, must start with sk_test_ and is never printed.
// The expected sandbox account id is passed by the operator so it never lands in the repo; without it nothing runs.
// Existing Stripe objects are never modified: an object that differs from the catalog below stops the script.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_TARGETS, apply, assertAccount, inspect, report, sql, sqlPacks, stripeClient } from './pay-stripe-mp/catalog-core.mjs';

const KEY_FILE = join(homedir(), '.graylum/secrets/stripe-test.env');

function loadKey() {
  if (!existsSync(KEY_FILE)) throw new Error(`missing ${KEY_FILE}`);
  const line = readFileSync(KEY_FILE, 'utf8').split('\n').map(l => l.trim())
    .find(l => /^(STRIPE_TEST_SECRET_KEY|STRIPE_SECRET_KEY)=/.test(l));
  const key = line?.split('=').slice(1).join('=').replace(/^['"]|['"]$/g, '');
  if (!key || !key.startsWith('sk_test_')) {
    console.error('STOP: key in stripe-test.env is missing or not an sk_test_ key. Nothing was called.');
    process.exit(2);
  }
  return key;
}

const command = process.argv[2];
if (!['plan', 'apply', 'sql', 'sql-packs'].includes(command)) {
  console.error('usage: node scripts/stripe-mp-sandbox-catalog.mjs plan|apply|sql|sql-packs');
  process.exit(2);
}
const stripe = stripeClient(loadKey(), 'test');
try { await assertAccount(stripe, process.env.MP_EXPECT_ACCOUNT, 'test'); }
catch (error) { console.error(error.message); process.exit(2); }
let state = await inspect(stripe);
if (command === 'apply') { await apply(stripe, state); state = await inspect(stripe); }
if (command === 'sql') console.log(sql(state, SANDBOX_TARGETS.sql));
else if (command === 'sql-packs') console.log(sqlPacks(state, SANDBOX_TARGETS.packs));
else report(state);
