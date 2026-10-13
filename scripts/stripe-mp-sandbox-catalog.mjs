#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PAY-STRIPE-MP: membership catalog for the Stripe TEST sandbox (staging). Not for production.
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

const KEY_FILE = join(homedir(), '.graylum/secrets/stripe-test.env');
const API_VERSION = '2026-04-22.dahlia';
const TAX_CODE = 'txcd_10105001'; // AI as a service, personal use (#847 2.2)

// Approved prices (MASTER_PLAN 2.1 item 51; Gold first month 2026-10-12). Amounts in cents.
// Credit packs (item 51 table): members only; Pro pays 95%, Gold 90%, rounded down to $0.10 like admission.
const PACKS = [
  { key: 's', id: '30000000-0000-4000-8000-000000000001', name: '积分包 小', price: 990, credits: 990, bonus: 0, pro: 940, gold: 890 },
  { key: 'm', id: '30000000-0000-4000-8000-000000000002', name: '积分包 中', price: 2990, credits: 2990, bonus: 0, pro: 2840, gold: 2690 },
  { key: 'l', id: '30000000-0000-4000-8000-000000000003', name: '积分包 大', price: 9990, credits: 9990, bonus: 1000, pro: 9490, gold: 8990 },
];
const memberPrice = (price, percent) => Math.floor(price * percent / 100 / 10) * 10;
for (const pack of PACKS) {
  if (memberPrice(pack.price, 95) !== pack.pro || memberPrice(pack.price, 90) !== pack.gold) throw new Error(`pack ${pack.key} table`);
}
const PRODUCTS = [{ id: 'graylum_mp_pro', level: 'pro', name: 'Graylum Pro' },
  { id: 'graylum_mp_gold', level: 'gold', name: 'Graylum Gold' },
  ...PACKS.map(pack => ({ id: `graylum_mp_pack_${pack.key}`, level: `pack_${pack.key}`, name: `Graylum ${pack.name}` }))];
const PLAN_PRICES = [
  ...[['pro', 'monthly', 2900], ['pro', 'yearly', 27900], ['gold', 'monthly', 6900], ['gold', 'yearly', 62100]]
    .flatMap(([level, cycle, amount]) => ['subscription', 'one_time'].map(usage => ({ level, cycle, amount, usage, offer: 'standard' }))),
  { level: 'gold', cycle: 'yearly', amount: 49600, usage: 'subscription', offer: 'founder' },
  { level: 'gold', cycle: 'yearly', amount: 49600, usage: 'one_time', offer: 'founder' },
  { level: 'gold', cycle: 'monthly', amount: 4900, usage: 'one_time', offer: 'gold_first30' },
].map(p => ({ ...p, product: `graylum_mp_${p.level}`, lookupKey: `graylum_mp_${p.level}_${p.usage}_${p.cycle}_${p.offer}` }));
const PACK_PRICES = PACKS.flatMap(pack => ['pro', 'gold'].map(tier => ({ pack, tier, level: `pack_${pack.key}`, cycle: 'one_time',
  amount: pack[tier], usage: 'package', offer: 'standard', product: `graylum_mp_pack_${pack.key}`,
  lookupKey: `graylum_mp_pack_${pack.key}_${tier}` })));
const PRICES = [...PLAN_PRICES, ...PACK_PRICES];
// Card first month: standard Gold monthly subscription price + this coupon (0222).
const COUPON = { id: 'graylum_mp_gold_first_month', level: 'gold', amountOff: 2000 };

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
const KEY = loadKey();

function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') encode(v, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe(method, path, params, idempotencyKey) {
  const body = params && method !== 'GET' ? encode(params).join('&') : undefined;
  const query = params && method === 'GET' ? `?${encode(params).join('&')}` : '';
  const res = await fetch(`https://api.stripe.com/v1${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body,
  });
  const json = await res.json();
  if (json && json.livemode === true) throw new Error('STOP: live-mode object returned');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Stripe ${method} ${path} failed: ${json.error?.type} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`);
  return json;
}

async function assertAccount() {
  const expected = process.env.MP_EXPECT_ACCOUNT;
  if (!expected || !/^acct_[A-Za-z0-9]+$/.test(expected)) {
    console.error('STOP: set MP_EXPECT_ACCOUNT to the sandbox account id. Nothing was called.');
    process.exit(2);
  }
  const [account, balance] = [await stripe('GET', '/account'), await stripe('GET', '/balance')];
  if (balance?.livemode !== false) throw new Error('STOP: balance not in test mode');
  if (account?.id !== expected) throw new Error('STOP: key belongs to a different Stripe account than expected');
  return account.id;
}

const taxCodeOf = product => typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
function productProblem(product, want) {
  if (!product.active) return 'inactive';
  if (taxCodeOf(product) !== TAX_CODE) return `tax_code ${taxCodeOf(product) ?? 'missing'}`;
  return product.metadata?.graylum_level === want.level ? null : 'metadata level';
}
function priceProblem(price, want) {
  const recurring = want.usage === 'subscription';
  const product = typeof price.product === 'string' ? price.product : price.product?.id;
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== want.amount || price.billing_scheme !== 'per_unit'
    || price.tax_behavior !== 'exclusive' || product !== want.product) return 'amount/currency/tax/product';
  if (price.type !== (recurring ? 'recurring' : 'one_time')) return 'type';
  if (recurring && (price.recurring?.interval !== (want.cycle === 'yearly' ? 'year' : 'month')
    || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed')) return 'interval';
  return null;
}
function couponProblem(coupon) {
  if (!coupon.valid || coupon.amount_off !== COUPON.amountOff || coupon.currency !== 'usd' || coupon.duration !== 'once'
    || coupon.percent_off !== null) return 'amount/duration';
  const products = coupon.applies_to?.products ?? [];
  return products.length === 1 && products[0] === 'graylum_mp_gold' ? null : 'applies_to';
}

async function inspect() {
  const products = await Promise.all(PRODUCTS.map(async want => ({ want, found: await stripe('GET', `/products/${want.id}`) })));
  const byKey = new Map();
  for (let i = 0; i < PRICES.length; i += 10) { // Stripe accepts at most 10 lookup keys per request.
    const listed = await stripe('GET', '/prices', { limit: 10, lookup_keys: PRICES.slice(i, i + 10).map(p => p.lookupKey) });
    for (const price of listed?.data ?? []) byKey.set(price.lookup_key, price);
  }
  const prices = PRICES.map(want => ({ want, found: byKey.get(want.lookupKey) ?? null }));
  const coupon = await stripe('GET', `/coupons/${COUPON.id}`, { 'expand[]': 'applies_to' });
  const problems = [
    ...products.filter(p => p.found).map(p => [p.want.id, productProblem(p.found, p.want)]),
    ...prices.filter(p => p.found).map(p => [p.want.lookupKey, priceProblem(p.found, p.want)]),
    ...(coupon ? [[COUPON.id, couponProblem(coupon)]] : []),
  ].filter(([, problem]) => problem);
  return { products, prices, coupon, problems };
}

function report(state) {
  const line = (name, found) => console.log(`${found ? 'exists ' : 'MISSING'}  ${name}`);
  for (const p of state.products) line(p.want.id, p.found);
  for (const p of state.prices) line(`${p.want.lookupKey} (${p.want.amount})`, p.found);
  line(COUPON.id, state.coupon);
  for (const [name, problem] of state.problems) console.log(`MISMATCH ${name}: ${problem}`);
}

async function apply(state) {
  if (state.problems.length) throw new Error('STOP: existing objects differ from the catalog; fix them by hand first');
  for (const p of state.products.filter(p => !p.found)) {
    await stripe('POST', '/products', { id: p.want.id, name: p.want.name, tax_code: TAX_CODE,
      metadata: { graylum_level: p.want.level, graylum_catalog: 'pay-stripe-mp' } }, `graylum-mp-product-${p.want.id}`);
  }
  for (const p of state.prices.filter(p => !p.found)) {
    const recurring = p.want.usage === 'subscription';
    await stripe('POST', '/prices', { product: p.want.product, currency: 'usd', unit_amount: p.want.amount,
      tax_behavior: 'exclusive', lookup_key: p.want.lookupKey,
      ...(recurring ? { recurring: { interval: p.want.cycle === 'yearly' ? 'year' : 'month', interval_count: 1 } } : {}),
      metadata: { graylum_catalog: 'pay-stripe-mp', graylum_offer: p.want.offer, graylum_usage: p.want.usage } },
    `graylum-mp-price-${p.want.lookupKey}`);
  }
  if (!state.coupon) {
    await stripe('POST', '/coupons', { id: COUPON.id, amount_off: COUPON.amountOff, currency: 'usd', duration: 'once',
      name: 'Gold first month', applies_to: { products: ['graylum_mp_gold'] }, metadata: { graylum_catalog: 'pay-stripe-mp' } },
    `graylum-mp-coupon-${COUPON.id}`);
  }
}

const q = value => `'${String(value).replaceAll("'", "''")}'`;
// Staging has exactly one Stripe test merchant; the SQL reads it instead of embedding the account id.
const MERCHANT = "(SELECT DISTINCT merchant_namespace FROM payment_provider_refs WHERE channel='stripe' AND mode='test')";
function sql(state) {
  if (state.problems.length || state.prices.some(p => !p.found) || !state.coupon) {
    throw new Error('STOP: run plan/apply until every catalog object exists and matches');
  }
  const rows = [...state.prices.filter(p => p.want.usage !== 'package').map(p => ({ type: 'price', external: p.found.id, ...p.want })),
    { type: 'coupon', external: state.coupon.id, level: COUPON.level, cycle: 'monthly', offer: 'gold_first30', usage: 'subscription' }];
  const lines = ['-- PAY-STRIPE-MP sandbox catalog mapping (staging only). Generated; review before running.', 'BEGIN;',
    // The approved catalog must already be in membership_plans; otherwise admission refuses anyway.
    `DO $$ BEGIN IF (SELECT count(*) FROM membership_plans WHERE (level,monthly_price,yearly_price) IN
  (('pro',2900,27900),('gold',6900,62100)))<>2 THEN RAISE EXCEPTION 'membership_plans not on the approved catalog'; END IF;
  IF (SELECT count(DISTINCT merchant_namespace) FROM payment_provider_refs WHERE channel='stripe' AND mode='test')<>1 THEN
    RAISE EXCEPTION 'expected exactly one Stripe test merchant'; END IF; END $$;`];
  for (const r of rows) {
    const plan = `(SELECT id FROM membership_plans WHERE level=${q(r.level)})`;
    lines.push(`UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=${MERCHANT}
  AND mode='test' AND object_type=${q(r.type)} AND membership_plan_id=${plan} AND billing_cycle=${q(r.cycle)}
  AND offer_kind=${q(r.offer)} AND price_usage=${q(r.usage)} AND is_current AND external_id<>${q(r.external)};`);
    lines.push(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
  billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe',${MERCHANT},'test',${q(r.type)},${q(r.external)},${plan},
  ${q(r.cycle)},true,${q(r.offer)},${q(r.usage)}) ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;`);
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

// Staging credit packs: the approved three replace the old test packs (kept, deactivated: orders reference them).
// No "popular" badge: which pack to highlight is a product choice that has not been made.
function sqlPacks(state) {
  if (state.problems.length || state.prices.some(p => !p.found)) throw new Error('STOP: run plan/apply first');
  const ids = PACKS.map(pack => q(pack.id)).join(',');
  const lines = ['-- PAY-STRIPE-MP sandbox credit packs (staging only). Generated; review before running.', 'BEGIN;',
    `DO $$ BEGIN IF (SELECT count(DISTINCT merchant_namespace) FROM payment_provider_refs WHERE channel='stripe' AND mode='test')<>1
  THEN RAISE EXCEPTION 'expected exactly one Stripe test merchant'; END IF; END $$;`];
  PACKS.forEach((pack, index) => lines.push(`INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,sort_order,
  is_popular,active) VALUES(${q(pack.id)},${q(pack.name)},${pack.price},${pack.credits},${pack.bonus},${index + 1},
  'false','true') ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,
  credits_amount=excluded.credits_amount,bonus_credits=excluded.bonus_credits,sort_order=excluded.sort_order,
  is_popular=excluded.is_popular,active='true',updated_at=now();`));
  lines.push(`UPDATE credit_packages SET active='false',updated_at=now() WHERE active='true' AND id NOT IN (${ids});`);
  for (const p of state.prices.filter(p => p.want.usage === 'package')) {
    const pack = q(p.want.pack.id);
    lines.push(`UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=${MERCHANT}
  AND mode='test' AND object_type='price' AND credit_package_id=${pack} AND billing_cycle='one_time' AND package_tier=${q(p.want.tier)}
  AND is_current AND external_id<>${q(p.found.id)};`);
    lines.push(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
  billing_cycle,is_current,offer_kind,price_usage,package_tier) VALUES('stripe',${MERCHANT},'test','price',${q(p.found.id)},${pack},
  'one_time',true,'standard','package',${q(p.want.tier)}) ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO UPDATE SET is_current=true;`);
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

const command = process.argv[2];
if (!['plan', 'apply', 'sql', 'sql-packs'].includes(command)) {
  console.error('usage: node scripts/stripe-mp-sandbox-catalog.mjs plan|apply|sql|sql-packs');
  process.exit(2);
}
await assertAccount();
let state = await inspect();
if (command === 'apply') { await apply(state); state = await inspect(); }
if (command === 'sql') console.log(sql(state));
else if (command === 'sql-packs') console.log(sqlPacks(state));
else report(state);
