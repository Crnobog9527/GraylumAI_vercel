/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { COUPON, PRICES, SANDBOX_TARGETS, assertAccount, liveTargets, sql, sqlPacks, stripeClient }
  from '../pay-stripe-mp/catalog-core.mjs';

const root = resolve(import.meta.dirname, '../..');
const committed = name => readFileSync(resolve(root, 'scripts/pay-stripe-mp', name), 'utf8');
const inserted = text => [...text.matchAll(/INSERT INTO payment_provider_refs[\s\S]*?VALUES\('stripe',[^,]*\),'test','(?:price|coupon)','([^']+)'/g)]
  .map(match => match[1]);
// The state the committed staging SQL was generated from: committed price ids in catalog order.
function stateFromCommitted() {
  const plan = inserted(committed('staging-catalog.sql')), packs = inserted(committed('staging-packs.sql'));
  const planPrices = PRICES.filter(p => p.usage !== 'package'), packPrices = PRICES.filter(p => p.usage === 'package');
  assert.equal(plan.length, planPrices.length + 1); assert.equal(packs.length, packPrices.length);
  const ids = new Map([...planPrices.map((p, i) => [p.lookupKey, plan[i]]), ...packPrices.map((p, i) => [p.lookupKey, packs[i]])]);
  return { problems: [], products: [], coupon: { id: plan.at(-1) }, prices: PRICES.map(want => ({ want, found: { id: ids.get(want.lookupKey) } })) };
}

test('the shared core regenerates the committed staging SQL unchanged', () => {
  const state = stateFromCommitted();
  assert.equal(state.coupon.id, COUPON.id);
  assert.equal(`${sql(state, SANDBOX_TARGETS.sql)}\n`, committed('staging-catalog.sql'));
  assert.equal(`${sqlPacks(state, SANDBOX_TARGETS.packs)}\n`, committed('staging-packs.sql'));
});

test('live SQL maps the same catalog in live mode under the checked live account only', () => {
  const state = stateFromCommitted(), targets = liveTargets('acct_LiveFixture');
  for (const text of [sql(state, targets.sql), sqlPacks(state, targets.packs)]) {
    assert.match(text, /LIVE/);
    assert.doesNotMatch(text, /'test'/);
    assert.match(text, /VALUES\('stripe','acct_LiveFixture','live',/);
  }
  assert.throws(() => liveTargets("acct_x' OR 1=1"), /invalid live account/);
});

test('a live run stops on any test-mode object and on a test-mode account', async () => {
  const reply = body => async () => ({ status: 200, ok: true, json: async () => body });
  await assert.rejects(stripeClient('rk_live_fixture', 'live', reply({ id: 'price_x', livemode: false }))('GET', '/prices'),
    /test-mode object returned to a live catalog run/);
  const answers = { '/account': { id: 'acct_LiveFixture' }, '/balance': { object: 'balance', livemode: false } };
  const fake = async url => ({ status: 200, ok: true, json: async () => answers[new URL(url).pathname.slice(3)] });
  await assert.rejects(assertAccount(async (_m, path) => answers[path], 'acct_LiveFixture', 'live'), /balance not in live mode/);
  answers['/balance'].livemode = true;
  assert.equal(await assertAccount(stripeClient('rk_live_fixture', 'live', fake), 'acct_LiveFixture', 'live'), 'acct_LiveFixture');
  await assert.rejects(assertAccount(stripeClient('rk_live_fixture', 'live', fake), 'acct_Other', 'live'), /different Stripe account/);
});

test('the live script refuses a missing or test key before any network call and never prints the key', () => {
  for (const key of ['', 'sk_test_fixtureSecretValue', 'pk_live_fixtureSecretValue']) {
    const run = spawnSync(process.execPath, [resolve(root, 'scripts/stripe-mp-live-catalog.mjs'), 'plan'], { encoding: 'utf8',
      env: { PATH: process.env.PATH, STRIPE_LIVE_SECRET_KEY: key, MP_EXPECT_ACCOUNT: 'acct_LiveFixture' } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not a live key/);
    if (key) assert.ok(!`${run.stdout}${run.stderr}`.includes(key));
  }
});
