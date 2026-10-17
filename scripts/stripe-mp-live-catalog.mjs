#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PAY-STRIPE-MP (R7, REL-1): the same membership catalog in the LIVE (production) Stripe account. Run by the Owner
// before launch; it creates real Stripe products, prices and the first-month coupon (creating them charges nobody).
//
//   STRIPE_LIVE_SECRET_KEY=sk_live_... MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-live-catalog.mjs plan
//       read-only: what exists / is missing in the live account
//   ... node scripts/stripe-mp-live-catalog.mjs apply       create only the missing objects (never edits existing ones)
//   ... node scripts/stripe-mp-live-catalog.mjs sql         print the production mapping SQL (membership prices, coupon)
//   ... node scripts/stripe-mp-live-catalog.mjs sql-packs   print the production credit-pack SQL
//
// The key is read only from the STRIPE_LIVE_SECRET_KEY environment variable, must be a live secret or restricted key
// (sk_live_ / rk_live_) and is never printed or written. Every Stripe answer must be a live-mode object. The generated SQL
// is printed to stdout for review and is run on the production database separately (Owner approval); never commit it.
import { apply, assertAccount, inspect, liveTargets, report, sql, sqlPacks, stripeClient } from './pay-stripe-mp/catalog-core.mjs';

const command = process.argv[2];
if (!['plan', 'apply', 'sql', 'sql-packs'].includes(command)) {
  console.error('usage: STRIPE_LIVE_SECRET_KEY=... MP_EXPECT_ACCOUNT=acct_... node scripts/stripe-mp-live-catalog.mjs plan|apply|sql|sql-packs');
  process.exit(2);
}
const key = process.env.STRIPE_LIVE_SECRET_KEY ?? '';
if (!/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) {
  console.error('STOP: STRIPE_LIVE_SECRET_KEY is missing or not a live key. Nothing was called.');
  process.exit(2);
}
const stripe = stripeClient(key, 'live');
let account;
try { account = await assertAccount(stripe, process.env.MP_EXPECT_ACCOUNT, 'live'); }
catch (error) { console.error(error.message); process.exit(2); }
let state = await inspect(stripe);
if (command === 'apply') { await apply(stripe, state); state = await inspect(stripe); }
const targets = liveTargets(account);
if (command === 'sql') console.log(sql(state, targets.sql));
else if (command === 'sql-packs') console.log(sqlPacks(state, targets.packs));
else report(state);
