/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Deep review 2026-11-11 item 1 (migration 0512): a buyer who left a checkout could never finish account erasure. Release
 * keeps status 'pending', and erasure_payment_terminal only knew the old path's failed/expired orders, so the financial
 * proof counted the order as money in flight forever and the auth identity was never deleted. Released, closed, unpaid
 * orders are final now; an open checkout and a released order that was paid late still hold the erasure. */
export async function erasureAbandonedCases({ admin, service }) {
  const gold = (await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const pro = (await admin.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
  const current = (await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version = current.version + 1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{ ...current, card: { enabled: true }, alipay: { enabled: true, annualVerified: true }, version }]);
  const digests = user => JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: user.replaceAll('-', '').repeat(2) }]);
  const buy = async (user, plan, method) => (await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',
    $2,'monthly',$3,'standard','fixture','test',$4,'terms-v1',$5) o`, [user, plan, method, version, digests(user)])).rows[0];
  // The checkout page opened: request frozen and sent, session bound (the shape a buyer leaves behind).
  // The frozen request has the shape buildStripeCheckoutRequest writes, so erasure can scrub it like a real one.
  const open = async (user, o) => {
    const expiry = new Date(Date.now() + 1800000), checkout = `cs_abandoned_${o.id.slice(0, 8)}`;
    const price = (await admin.query('SELECT external_id FROM payment_provider_refs WHERE id=$1', [o.price_ref_id])).rows[0].external_id;
    const metadata = { orderId: o.id, userId: user, itemId: o.item_id, itemType: 'membership_plan', billingCycle: 'monthly', priceId: price };
    const card = o.payment_method === 'card';
    const providerRequest = { client_reference_id: user, expires_at: Math.floor(expiry.getTime() / 1000),
      mode: card ? 'subscription' : 'payment', line_items: [{ price, quantity: 1 }], metadata,
      [card ? 'subscription_data' : 'payment_intent_data']: { metadata: { ...metadata } },
      ...(card ? { managed_payments: { enabled: true } } : { payment_method_types: [o.payment_method], customer_creation: 'always' }) };
    const request = { orderId: o.id, userId: user, method: o.payment_method, merchant: 'fixture', mode: 'test', providerRequest };
    assert.deepEqual((await admin.query("SELECT erasure_payment_envelope($1,'checkout') v", [request])).rows[0].v, request,
      'the fixture request is one erasure accepts');
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)', [user, o.id, 'fixture', request, expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)', [user, o.id, 'fixture', checkout, expiry]);
    return checkout;
  };
  const closeUnpaid = (o, checkout) => service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,'closed_unpaid',
    NULL,0,'usd',NULL) v`, [o.id, checkout]);
  const proof = async user => (await admin.query('SELECT account_erasure_financial_proof($1) v', [user])).rows[0].v;
  const preview = async user => (await admin.query('SELECT account_erasure_preview($1) v', [user])).rows[0].v;
  const terminal = async id => (await admin.query('SELECT erasure_payment_terminal(to_jsonb(o)) v FROM payment_orders o WHERE id=$1',
    [id])).rows[0].v;
  const newUser = async () => {
    const user = randomUUID();
    await admin.query("INSERT INTO profiles(id,credits,membership_level) VALUES($1,0,'free')", [user]);
    return user;
  };

  // One buyer leaves three checkouts: a card order never sent (released before dispatch), a card and an Alipay checkout
  // opened and closed unpaid by Stripe. Each stays status 'pending' with no close reason, as on staging.
  const left = await newUser();
  const never = await buy(left, gold, 'card');
  await service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,NULL)', [left, never.id, 'fixture']);
  const card = await buy(left, gold, 'card');
  const cardCheckout = await open(left, card);
  assert.equal((await closeUnpaid(card, cardCheckout)).rows[0].v, 'released');
  const wallet = await buy(left, pro, 'alipay');
  const walletCheckout = await open(left, wallet);
  assert.equal((await closeUnpaid(wallet, walletCheckout)).rows[0].v, 'released');
  // Duplicate: the close arrives again (webhook and reconciliation); nothing changes.
  assert.equal((await closeUnpaid(wallet, walletCheckout)).rows[0].v, 'released');
  const rows = (await admin.query(`SELECT status,qualification_state,purchase_close_reason FROM payment_orders WHERE user_id=$1
    ORDER BY created_at`, [left])).rows;
  assert.deepEqual(rows.map(r => [r.status, r.qualification_state, r.purchase_close_reason]),
    Array(3).fill(['pending', 'released', null]), 'released orders keep status pending and no close reason');
  for (const o of [never, card, wallet]) assert.equal(await terminal(o.id), true, o.payment_method);
  assert.equal((await proof(left)).financialPending, 0, 'abandoned checkouts are not money in flight');
  assert.equal((await preview(left)).pendingPayments, 0, 'nor "payments still processing" on the confirmation page');

  // An open checkout (not released) still holds the erasure.
  const waiting = await newUser();
  const pending = await buy(waiting, pro, 'alipay');
  await open(waiting, pending);
  assert.equal(await terminal(pending.id), false);
  assert.equal((await proof(waiting)).financialPending, 1);
  assert.equal((await preview(waiting)).pendingPayments, 1);
  // A payment that arrives after the close is cash under review: the order is not final and the erasure waits.
  const late = await newUser();
  const lateOrder = await buy(late, pro, 'alipay');
  const lateCheckout = await open(late, lateOrder);
  await closeUnpaid(lateOrder, lateCheckout);
  assert.equal(await terminal(lateOrder.id), true);
  assert.equal((await service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,'paid',$3,$4,'usd',now()) v`,
    [lateOrder.id, lateCheckout, `pi_late_${lateOrder.id.slice(0, 8)}`, lateOrder.amount_total])).rows[0].v, 'review');
  assert.equal(await terminal(lateOrder.id), false, 'paid after release is not final');
  assert.equal((await proof(late)).financialPending, 1);

  // The erasure itself: local cleanup scrubs the frozen checkout requests of the released orders (they are final now) and the
  // financial proof stays at zero, so nothing in the payment rows holds the auth deletion.
  await admin.query('SELECT account_erasure_confirm($1,$2)', [left, randomUUID()]);
  await admin.query('SELECT account_erasure_local_cleanup($1,true)', [left]);
  assert.equal((await admin.query(`SELECT count(*)::int n FROM payment_orders WHERE user_id=$1 AND checkout_request IS NOT NULL
    AND request_erased_at IS NULL`, [left])).rows[0].n, 0, 'the released checkout requests are scrubbed');
  assert.equal((await proof(left)).financialPending, 0);

  // Item 13 (Owner 2026-11-11): a refund request being handled stops erasure at the preview and at confirm; once it is
  // handled the account can be erased. An open billing ticket (账单/退款) is the request; a running refund approval too.
  const confirm = user => admin.query('SELECT account_erasure_confirm($1,$2) v', [user, randomUUID()]);
  const asking = await newUser();
  const ticket = (await admin.query(`INSERT INTO tickets(user_id,title,category,status) VALUES($1,'refund','billing','pending')
    RETURNING id`, [asking])).rows[0].id;
  assert.equal((await preview(asking)).refundRequestOpen, true);
  await assert.rejects(() => confirm(asking), /ACCOUNT_ERASURE_REFUND_PENDING/);
  assert.deepEqual((await admin.query('SELECT status,is_deleted FROM profiles WHERE id=$1', [asking])).rows[0],
    { status: 'active', is_deleted: 'false' }, 'the refused account stays open');
  assert.equal((await admin.query('SELECT count(*)::int n FROM account_erasure_requests WHERE profile_id=$1', [asking])).rows[0].n, 0);
  // Another category, a deleted ticket and a handled one do not block.
  await admin.query("UPDATE tickets SET category='technical' WHERE id=$1", [ticket]);
  assert.equal((await preview(asking)).refundRequestOpen, false);
  await admin.query("UPDATE tickets SET category='billing',is_deleted='true' WHERE id=$1", [ticket]);
  assert.equal((await preview(asking)).refundRequestOpen, false);
  await admin.query("UPDATE tickets SET is_deleted='false',status='in_progress' WHERE id=$1", [ticket]);
  assert.equal((await preview(asking)).refundRequestOpen, true);
  await admin.query("UPDATE tickets SET status='resolved' WHERE id=$1", [ticket]);
  assert.equal((await preview(asking)).refundRequestOpen, false);
  // A refund approval still running blocks even with the ticket handled; a finished one does not.
  const approved = await buy(asking, pro, 'alipay');
  await admin.query(`UPDATE payment_orders SET refund_approval=jsonb_build_object('status','pending') WHERE id=$1`, [approved.id]);
  assert.equal((await preview(asking)).refundRequestOpen, true);
  await assert.rejects(() => confirm(asking), /ACCOUNT_ERASURE_REFUND_PENDING/);
  await admin.query(`UPDATE payment_orders SET refund_approval=jsonb_build_object('status','rejected') WHERE id=$1`, [approved.id]);
  assert.equal((await preview(asking)).refundRequestOpen, false);
  assert.equal((await confirm(asking)).rows[0].v.created, true, 'handled: the erasure starts');
  assert.equal((await confirm(asking)).rows[0].v.created, false, 'a replay returns the same request');
  // Not callable by the API roles.
  for (const [role, want] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
    assert.equal((await admin.query("SELECT has_function_privilege($1,'public.account_erasure_refund_open(uuid)','EXECUTE') v",
      [role])).rows[0].v, want, role);
  }

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'", [{ ...current, version: version + 1 }]);
  return ['erasure-abandoned-released-final', 'erasure-abandoned-preview-not-pending', 'erasure-abandoned-duplicate-close',
    'erasure-abandoned-open-checkout-still-pending', 'erasure-abandoned-late-payment-still-pending',
    'erasure-abandoned-requests-scrubbed', 'erasure-refund-open-blocks-preview-and-confirm', 'erasure-refund-handled-allows',
    'erasure-refund-open-service-only'];
}
