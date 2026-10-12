#!/usr/bin/env node
// Stripe Managed Payments (MP) test-mode probe. Evidence tooling only; not product code.
//
// Usage:
//   node mp-probe.mjs setup     create test products, prices, coupon, test clocks, customers, Checkout Sessions
//   node mp-probe.mjs urls      print Checkout URLs for the browser handoff (local terminal only, never commit)
//   node mp-probe.mjs inspect   read back sessions, subscriptions, invoices, charges, balance transactions, events
//   node mp-probe.mjs advance <scenario> <days>   advance that scenario's test clock
//   node mp-probe.mjs ops       upgrade Pro->Gold, cancel at period end, refund (after payments)
//
// The secret key is read only from ~/.graylum/secrets/stripe-test.env and must start with sk_test_.
// It is never printed. Raw state (object ids, URLs) lives outside the repo in ~/.graylum/stripe-mp-state.json;
// only the redacted summaries written by `inspect`/`setup` go into this evidence folder.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_FILE = join(homedir(), '.graylum/secrets/stripe-test.env');
const STATE_FILE = join(homedir(), '.graylum/stripe-mp-state.json');
const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const API_VERSION = '2026-04-22.dahlia';
const SUCCESS = 'https://example.com/mp-probe/success?session_id={CHECKOUT_SESSION_ID}';
const CANCEL = 'https://example.com/mp-probe/cancel';
const DAY = 86400;

function loadKey() {
  if (!existsSync(KEY_FILE)) throw new Error(`missing ${KEY_FILE}`);
  const line = readFileSync(KEY_FILE, 'utf8').split('\n')
    .map((l) => l.trim()).find((l) => /^(STRIPE_TEST_SECRET_KEY|STRIPE_SECRET_KEY)=/.test(l));
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

async function stripe(method, path, params) {
  const body = params && method !== 'GET' ? encode(params).join('&') : undefined;
  const query = params && method === 'GET' ? `?${encode(params).join('&')}` : '';
  const res = await fetch(`https://api.stripe.com/v1${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body,
  });
  const json = await res.json();
  if (json && json.livemode === true) throw new Error('STOP: live-mode object returned');
  if (!res.ok) return { error: { status: res.status, type: json.error?.type, code: json.error?.code,
    param: json.error?.param, message: json.error?.message } };
  return json;
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
const out = (name, data) => writeFileSync(join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);

// Keep evidence free of anything personal or secret: mask account ids, emails, URLs, client secrets.
function redact(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => {
    if (['client_secret', 'url', 'hosted_invoice_url', 'invoice_pdf', 'receipt_url', 'return_url',
      'success_url', 'cancel_url'].includes(k)) return v ? '[redacted]' : v;
    if (['email', 'phone', 'name', 'line1', 'line2', 'postal_code', 'fingerprint', 'last4', 'ip_address']
      .includes(k)) return v ? '[redacted]' : v;
    if (typeof v === 'string' && /^acct_/.test(v)) return 'acct_[redacted]';
    return v;
  }));
}

async function setup() {
  const now = Math.floor(Date.now() / 1000);
  const account = await stripe('GET', '/account');
  const balance = await stripe('GET', '/balance');
  if (balance.livemode !== false) throw new Error('STOP: balance not in test mode');
  // The expected sandbox id is passed in by the operator so it never lands in the repo.
  if (process.env.MP_EXPECT_ACCOUNT && account.id !== process.env.MP_EXPECT_ACCOUNT) {
    throw new Error('STOP: key belongs to a different Stripe account than the MP sandbox');
  }
  state.account = { country: account.country, default_currency: account.default_currency,
    business_type: account.business_type, error: account.error };

  const product = async (name, tax_code) => stripe('POST', '/products', {
    name, ...(tax_code ? { tax_code } : {}), metadata: { mp_probe: '20261012' } });
  const price = async (productId, amount, interval) => stripe('POST', '/prices', {
    product: productId, currency: 'usd', unit_amount: amount, tax_behavior: 'exclusive',
    ...(interval ? { recurring: { interval } } : {}), metadata: { mp_probe: '20261012' } });

  // txcd_10105001 = AI as a Service, cloud based, personal use (eligible for MP).
  const TAX = 'txcd_10105001';
  const gold = await product('MP probe Gold', TAX);
  const pro = await product('MP probe Pro', TAX);
  const founder = await product('MP probe Founder', TAX);
  const firstTerm = await product('MP probe Gold first 30 days', TAX);
  const noTax = await product('MP probe no tax code', undefined);
  const p = {
    gold_month: await price(gold.id, 6900, 'month'),
    pro_month: await price(pro.id, 2900, 'month'),
    founder_year: await price(founder.id, 49600, 'year'),
    first_term_once: await price(firstTerm.id, 4900),
    gold_once: await price(gold.id, 6900),
    notax_month: await price(noTax.id, 6900, 'month'),
  };
  const coupon = await stripe('POST', '/coupons', { amount_off: 2000, currency: 'usd', duration: 'once',
    name: 'MP probe Gold first term', metadata: { mp_probe: '20261012' } });
  state.products = { gold: gold.id, pro: pro.id, founder: founder.id, firstTerm: firstTerm.id, noTax: noTax.id };
  state.prices = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.id ?? v]));
  state.coupon = coupon.id ?? coupon;

  // Each paid scenario gets its own test clock and customer so renewals can be advanced independently.
  const clocked = async (key) => {
    const clock = await stripe('POST', '/test_helpers/test_clocks', { frozen_time: now, name: `mp-${key}` });
    const customer = await stripe('POST', '/customers', { email: `mp-probe-${key}@example.com`,
      test_clock: clock.id, metadata: { mp_probe: '20261012' } });
    return { clock: clock.id ?? clock, customer: customer.id ?? customer };
  };
  const base = { success_url: SUCCESS, cancel_url: CANCEL, metadata: { mp_probe: '20261012' } };
  const mpSub = (extra) => ({ ...base, mode: 'subscription', managed_payments: { enabled: true }, ...extra });

  const scenarios = {
    // Item 1/3/4: plain MP Gold monthly, card 4242; also used for refund + cancel.
    s1_gold_basic: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.gold_month.id, quantity: 1 }] }) },
    // Item 2 option A: once-only coupon (first monthly invoice 49, then 69). Calendar month, not 30 days.
    s2_coupon_once: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.gold_month.id, quantity: 1 }], discounts: [{ coupon: coupon.id }] }) },
    // Item 2 option B: 30-day trial + one-time 49 on the initial invoice; recurring 69 starts on day 30.
    s3_trial30_plus49: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.gold_month.id, quantity: 1 }, { price: p.first_term_once.id, quantity: 1 }],
      subscription_data: { trial_period_days: 30 } }) },
    // Item 2 option C: billing anchor at +30 days, no proration, one-time 49 now. No "trial" wording.
    s4_anchor30_plus49: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.gold_month.id, quantity: 1 }, { price: p.first_term_once.id, quantity: 1 }],
      subscription_data: { billing_cycle_anchor: now + 30 * DAY, proration_behavior: 'none' } }) },
    // Item 3: renewal failure. Paid with 4000 0000 0000 0341 (attaches, later charges decline).
    s5_renewal_fail: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.gold_month.id, quantity: 1 }], subscription_data: { trial_period_days: 3 } }) },
    // Item 4: founder 496/year fixed-price renewal.
    s6_founder_year: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.founder_year.id, quantity: 1 }] }) },
    // Item 4: Pro monthly, upgraded to Gold via API after payment.
    s7_pro_upgrade: { clocked: true, params: (c) => mpSub({ customer: c,
      line_items: [{ price: p.pro_month.id, quantity: 1 }] }) },
    // Item 1: non-MP wallet one-time sessions in the same account, shaped like stripeCheckoutIntent.ts.
    w1_wechat_once: { clocked: false, params: () => ({ ...base, mode: 'payment', customer_creation: 'always',
      payment_method_types: ['wechat_pay'], payment_method_options: { wechat_pay: { client: 'web' } },
      line_items: [{ price: p.gold_once.id, quantity: 1 }] }) },
    w2_alipay_once: { clocked: false, params: () => ({ ...base, mode: 'payment', customer_creation: 'always',
      payment_method_types: ['alipay'], line_items: [{ price: p.gold_once.id, quantity: 1 }] }) },
  };
  // API-only compatibility probes: we only record whether Stripe accepts the Session.
  const probes = {
    n1_mp_with_payment_method_types: mpSub({ line_items: [{ price: p.gold_month.id, quantity: 1 }],
      payment_method_types: ['card'] }),
    n2_mp_with_automatic_tax: mpSub({ line_items: [{ price: p.gold_month.id, quantity: 1 }],
      automatic_tax: { enabled: true } }),
    n3_mp_product_without_tax_code: mpSub({ line_items: [{ price: p.notax_month.id, quantity: 1 }] }),
    n4_mp_trial_end_exact_30d: mpSub({ line_items: [{ price: p.gold_month.id, quantity: 1 }],
      subscription_data: { trial_end: now + 30 * DAY } }),
    n5_mp_allow_promotion_codes: mpSub({ line_items: [{ price: p.gold_month.id, quantity: 1 }],
      allow_promotion_codes: true }),
    n6_mp_wallet_one_time: { ...base, mode: 'payment', managed_payments: { enabled: true },
      line_items: [{ price: p.gold_once.id, quantity: 1 }], payment_method_types: ['wechat_pay'] },
    n7_mp_payment_mode_card: { ...base, mode: 'payment', managed_payments: { enabled: true },
      line_items: [{ price: p.gold_once.id, quantity: 1 }] },
    n8_non_mp_card_subscription: { ...base, mode: 'subscription', payment_method_types: ['card'],
      line_items: [{ price: p.gold_month.id, quantity: 1 }] },
  };

  state.scenarios = {};
  for (const [key, s] of Object.entries(scenarios)) {
    const ids = s.clocked ? await clocked(key) : {};
    const session = await stripe('POST', '/checkout/sessions', s.params(ids.customer));
    state.scenarios[key] = { ...ids, session: session.id, url: session.url, error: session.error,
      managed_payments: session.managed_payments, amount_total: session.amount_total,
      payment_method_types: session.payment_method_types };
  }
  state.probes = {};
  for (const [key, params] of Object.entries(probes)) {
    const session = await stripe('POST', '/checkout/sessions', params);
    state.probes[key] = session.error ? { accepted: false, error: session.error }
      : { accepted: true, session: session.id, managed_payments: session.managed_payments,
        payment_method_types: session.payment_method_types, amount_total: session.amount_total,
        subscription_trial_end: params.subscription_data?.trial_end ?? null };
    if (session.id) await stripe('POST', `/checkout/sessions/${session.id}/expire`);
  }
  state.created_at = now;
  save();
  out('01-setup.json', redact({ api_version: API_VERSION, created_at: now, account: state.account,
    scenarios: Object.fromEntries(Object.entries(state.scenarios).map(([k, v]) =>
      [k, { session_created: !v.error, error: v.error, managed_payments: v.managed_payments,
        amount_total: v.amount_total, payment_method_types: v.payment_method_types, test_clock: Boolean(v.clock) }])),
    probes: state.probes }));
  console.log('setup done; see 01-setup.json');
}

// Item 5/6: one more MP session where the tester enters a mainland China billing address (restricted country).
async function extra() {
  const session = await stripe('POST', '/checkout/sessions', { success_url: SUCCESS, cancel_url: CANCEL,
    mode: 'subscription', managed_payments: { enabled: true }, metadata: { mp_probe: '20261012' },
    line_items: [{ price: state.prices.gold_month, quantity: 1 }] });
  state.scenarios.s8_cn_address = { session: session.id, url: session.url, error: session.error };
  save();
  console.log('extra done', session.error ? 'error' : 'ok');
}

async function status() {
  for (const [k, v] of Object.entries(state.scenarios ?? {})) {
    if (!v.session) continue;
    const cs = await stripe('GET', `/checkout/sessions/${v.session}`);
    console.log(k, cs.status, cs.payment_status);
  }
}

function urls() {
  for (const [k, v] of Object.entries(state.scenarios ?? {})) console.log(k, v.url ?? v.error?.message);
}

async function expandSession(id) {
  return stripe('GET', `/checkout/sessions/${id}`, { expand: ['subscription', 'payment_intent', 'invoice'] });
}

async function chargeDetail(chargeId) {
  if (!chargeId) return null;
  const ch = await stripe('GET', `/charges/${chargeId}`, { expand: ['balance_transaction'] });
  const bt = ch.balance_transaction;
  return { id: ch.id, amount: ch.amount, currency: ch.currency, status: ch.status,
    payment_method_type: ch.payment_method_details?.type, statement_descriptor: ch.calculated_statement_descriptor,
    balance_transaction: bt && { amount: bt.amount, fee: bt.fee, net: bt.net, currency: bt.currency,
      fee_details: bt.fee_details, reporting_category: bt.reporting_category, type: bt.type } };
}

async function inspect() {
  const report = {};
  for (const [key, s] of Object.entries(state.scenarios ?? {})) {
    if (!s.session) { report[key] = { error: s.error }; continue; }
    const cs = await expandSession(s.session);
    const sub = cs.subscription && typeof cs.subscription === 'object' ? cs.subscription : null;
    const invoices = sub ? await stripe('GET', '/invoices', { subscription: sub.id, limit: 10 }) : null;
    const invoiceRows = [];
    for (const inv of invoices?.data ?? []) {
      const pay = await stripe('GET', '/invoice_payments', { invoice: inv.id, limit: 3,
        expand: ['data.payment.payment_intent'] });
      const pi = pay.data?.[0]?.payment?.payment_intent;
      invoiceRows.push({ id: inv.id, status: inv.status, billing_reason: inv.billing_reason,
        amount_due: inv.amount_due, amount_paid: inv.amount_paid, subtotal: inv.subtotal, total: inv.total,
        total_taxes: inv.total_taxes, total_discount_amounts: inv.total_discount_amounts,
        period_start: inv.period_start, period_end: inv.period_end, attempt_count: inv.attempt_count,
        next_payment_attempt: inv.next_payment_attempt,
        lines: inv.lines?.data?.map((l) => ({ amount: l.amount, description: l.description,
          period: l.period, pricing: l.pricing?.price_details?.price })),
        charge: await chargeDetail(typeof pi === 'object' ? pi?.latest_charge : null) });
    }
    const pi = cs.payment_intent && typeof cs.payment_intent === 'object' ? cs.payment_intent : null;
    report[key] = {
      session: { status: cs.status, payment_status: cs.payment_status, mode: cs.mode,
        managed_payments: cs.managed_payments, amount_subtotal: cs.amount_subtotal, amount_total: cs.amount_total,
        total_details: cs.total_details, currency: cs.currency, presentment_details: cs.presentment_details,
        customer_details_country: cs.customer_details?.address?.country ?? null,
        payment_method_types: cs.payment_method_types },
      subscription: sub && { status: sub.status, managed_payments: sub.managed_payments,
        trial_start: sub.trial_start, trial_end: sub.trial_end, billing_cycle_anchor: sub.billing_cycle_anchor,
        start_date: sub.start_date, cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at,
        items: sub.items?.data?.map((i) => ({ price: i.price?.id, unit_amount: i.price?.unit_amount,
          interval: i.price?.recurring?.interval, current_period_start: i.current_period_start,
          current_period_end: i.current_period_end })),
        default_payment_method: Boolean(sub.default_payment_method) },
      invoices: invoiceRows,
      payment_intent: pi && { status: pi.status, amount: pi.amount, managed_payments: pi.managed_payments,
        charge: await chargeDetail(pi.latest_charge) },
      clock: s.clock ? await stripe('GET', `/test_helpers/test_clocks/${s.clock}`)
        .then((c) => ({ status: c.status, frozen_time: c.frozen_time })) : null,
    };
  }
  const events = await stripe('GET', '/events', { limit: 100, created: { gte: state.created_at } });
  const shapes = {};
  for (const e of events.data ?? []) {
    const o = e.data?.object ?? {};
    const t = `${e.type}`;
    shapes[t] ??= { count: 0, object: o.object, top_level_keys: Object.keys(o).sort(),
      managed_payments_field: o.managed_payments ?? null };
    shapes[t].count++;
  }
  report.events = { total: events.data?.length, has_more: events.has_more, shapes };
  out(`02-inspect-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, redact(report));
  console.log('inspect done');
}

async function advance(key, days) {
  const s = state.scenarios?.[key];
  if (!s?.clock) throw new Error(`no clock for ${key}`);
  const clock = await stripe('GET', `/test_helpers/test_clocks/${s.clock}`);
  const target = clock.frozen_time + Math.round(Number(days) * DAY);
  const res = await stripe('POST', `/test_helpers/test_clocks/${s.clock}/advance`, { frozen_time: target });
  for (let i = 0; i < 60; i++) {
    const c = await stripe('GET', `/test_helpers/test_clocks/${s.clock}`);
    if (c.status === 'ready') { console.log(`${key} clock ready at +${days}d`); return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`${key} clock still advancing`, res.error ?? '');
}

async function ops() {
  const result = {};
  const sub = async (key) => (await expandSession(state.scenarios[key].session)).subscription;
  const pro = await sub('s7_pro_upgrade');
  if (pro?.id) {
    const item = pro.items.data[0];
    result.upgrade_pro_to_gold = redact(await stripe('POST', `/subscriptions/${pro.id}`, {
      items: [{ id: item.id, price: state.prices.gold_month }], proration_behavior: 'always_invoice' }));
    result.upgrade_pro_to_gold = { error: result.upgrade_pro_to_gold.error,
      status: result.upgrade_pro_to_gold.status, price: result.upgrade_pro_to_gold.items?.data?.[0]?.price?.id };
    result.upgrade_latest_invoice = await stripe('GET', '/invoices', { subscription: pro.id, limit: 1 })
      .then((l) => l.data?.[0] && { amount_due: l.data[0].amount_due, amount_paid: l.data[0].amount_paid,
        status: l.data[0].status, billing_reason: l.data[0].billing_reason,
        lines: l.data[0].lines?.data?.map((x) => ({ amount: x.amount, description: x.description })) });
  }
  const basic = await sub('s1_gold_basic');
  if (basic?.id) {
    const c = await stripe('POST', `/subscriptions/${basic.id}`, { cancel_at_period_end: true });
    result.cancel_at_period_end = { error: c.error, status: c.status, cancel_at_period_end: c.cancel_at_period_end,
      cancel_at: c.cancel_at };
    const pm = await stripe('POST', `/subscriptions/${basic.id}`, { default_payment_method: 'pm_card_visa' });
    result.update_default_payment_method = { error: pm.error, accepted: !pm.error };
    const inv = await stripe('GET', '/invoices', { subscription: basic.id, limit: 1 });
    const pay = await stripe('GET', '/invoice_payments', { invoice: inv.data[0].id, limit: 1 });
    const piId = pay.data?.[0]?.payment?.payment_intent;
    const refund = await stripe('POST', '/refunds', { payment_intent: piId, amount: 1000 });
    result.partial_refund = { error: refund.error, status: refund.status, amount: refund.amount };
    if (refund.id) {
      const r = await stripe('GET', `/refunds/${refund.id}`, { expand: ['balance_transaction'] });
      const bt = r.balance_transaction;
      result.partial_refund.balance_transaction = bt && { amount: bt.amount, fee: bt.fee, net: bt.net,
        fee_details: bt.fee_details, reporting_category: bt.reporting_category };
    }
  }
  out(`03-ops-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, redact(result));
  console.log('ops done');
}

const [cmd, a, b] = process.argv.slice(2);
const run = { setup, extra, status, urls, inspect, ops, advance: () => advance(a, b) }[cmd];
if (!run) { console.error('commands: setup | urls | inspect | advance <scenario> <days> | ops'); process.exit(1); }
await run();
