/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLegacyOrder, verifyLegacyCheckout } from '../legacy-checkout/evidence.mjs';
import { processOrder, inventory } from '../legacy-checkout/database.mjs';
import { parseOptions } from '../legacy-checkout-cleanup.mjs';
import { fixture } from './legacy-checkout-fixture.mjs';

test('expired unpaid legacy membership is eligible without database writes', async () => {
  const t = fixture();
  assert.deepEqual(await processOrder(t), { orderId: t.order.id, outcome: 'eligible' });
  assert.deepEqual(t.calls, ['retrieve', 'subscriptions', 'invoices']);
});
for (const [key, value] of Object.entries({ status: 'open', payment_status: 'paid', subscription: 'sub_fixture',
  invoice: 'in_fixture', payment_intent: 'pi_fixture', setup_intent: 'seti_fixture',
  after_expiration: { recovery: { enabled: true } }, expires_at: 9999999999, livemode: true,
  id: 'cs_test_wrong', client_reference_id: 'wrong', customer: 'cus_wrong', amount_total: 991,
  currency: 'eur', mode: 'payment', object: 'other', metadata: {} })) {
  test(`refuses session ${key} mismatch`, async () => {
    const t = fixture(); t.session[key] = value;
    assert.equal((await processOrder(t)).outcome, 'unresolved');
  });
}
for (const field of ['invoice', 'subscription', 'payment_intent', 'setup_intent', 'after_expiration', 'customer', 'expires_at']) {
  test(`missing ${field} is not proof of absence`, async () => {
    const t = fixture(); delete t.session[field];
    assert.equal((await processOrder(t)).outcome, 'unresolved');
  });
}
for (const [key, value] of Object.entries({ status: 'completed', payment_status: null, fulfilled_at: '2026-09-22',
  stripe_invoice_id: 'in_fixture', stripe_subscription_id: 'sub_fixture', payment_channel: 'stripe',
  created_at: '2026-09-23', amount_total: null, has_related_facts: true, payment_amount_facts: [],
  purchase_close_ref: 'cs_test_fixture', user_id: null })) {
  test(`local ${key} mismatch does not reach Stripe or close`, async () => {
    const t = fixture(); t.order[key] = value;
    assert.equal((await processOrder({ ...t, apply: true })).outcome, 'unresolved');
    assert.deepEqual(t.calls, []);
  });
}
for (const kind of ['subscriptions', 'invoices']) {
  for (const result of [{ object: 'list', data: [{}], has_more: false }, { object: 'list', data: [], has_more: true },
    { object: 'list', data: [] }, { data: [], has_more: false }]) {
    test(`nonempty or incomplete ${kind} requires manual reconciliation`, async () => {
      const t = fixture(); t.stripe[kind].list = async () => result;
      assert.equal((await processOrder(t)).outcome, 'unresolved');
    });
  }
}
test('provider error is sanitized, never returned verbatim', async () => {
  const t = fixture(); t.stripe.checkout.sessions.retrieve = async () => { throw new Error('private diagnostic'); };
  const result = await processOrder(t);
  assert.equal(result.reason, 'EVIDENCE_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('already closed is recognized only with matching closure evidence', async () => {
  const t = fixture(); Object.assign(t.order, { status: 'expired', purchase_closed_at: '2026-10-06',
    purchase_close_reason: 'stripe_checkout_expired', purchase_close_ref: t.session.id });
  assert.equal(assertLegacyOrder(t.order), true);
  assert.equal((await processOrder(t)).outcome, 'already_closed');
});
test('live requires a live session; test mode never accepts it', async () => {
  const t = fixture(); t.scope.mode = 'live';
  await assert.rejects(verifyLegacyCheckout(t.stripe, t.order, t.scope));
  t.session.id = t.order.stripe_checkout_session_id = 'cs_live_fixture'; t.session.livemode = true;
  await verifyLegacyCheckout(t.stripe, t.order, t.scope);
});
test('inventory uses a read-only transaction and refuses silent truncation', async () => {
  const calls = [];
  const db = { query: async text => { calls.push(text); return { rows: text.startsWith('SELECT') ? Array(1001).fill({}) : [] }; } };
  await assert.rejects(inventory(db), /INVENTORY_INCOMPLETE/);
  assert.equal(calls[0], 'BEGIN READ ONLY'); assert.equal(calls.at(-1), 'ROLLBACK');
});
test('CLI requires explicit target, approvals, restricted key mode, and one order for writes', () => {
  const env = { LEGACY_CLEANUP_DATABASE_URL: 'postgresql://localhost/fixture',
    LEGACY_CLEANUP_STRIPE_KEY: ['rk', 'test', 'fixture'].join('_'), LEGACY_CLEANUP_STRIPE_ACCOUNT: 'acct_fixture' };
  const base = ['--target', 'staging', '--approved-read'];
  assert.equal(parseOptions(base, env).apply, false);
  assert.throws(() => parseOptions([], env));
  assert.throws(() => parseOptions([...base, '--apply'], env));
  assert.throws(() => parseOptions([...base, '--apply', '--approved-close'], env));
  assert.throws(() => parseOptions([...base, '--unknown'], env));
  assert.throws(() => parseOptions(['--target', 'production', '--approved-read'], env));
  assert.equal(parseOptions([...base, '--apply', '--approved-close', '--order-id', fixture().order.id], env).apply, true);
});

test('any recovery configuration remains unresolved even when currently disabled', async () => {
  const t = fixture(); t.session.after_expiration = { recovery: { enabled: false } };
  assert.equal((await processOrder(t)).outcome, 'unresolved');
});
