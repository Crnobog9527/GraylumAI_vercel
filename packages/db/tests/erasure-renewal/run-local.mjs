/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only DATA-ERASURE 0224 verification: auto-renewal blocks erasure on every payment channel.
// Channels: legacy Stripe (subscription id), Waffo card (0211), Stripe Managed Payments card and
// mainland card_cn (no Stripe subscription id; card_cn order method simulated, see simulateCardCn).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0224_erasure_renewal_any_channel.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0224', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.message, expected);
const plan = async () => v(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
  VALUES('Renewal fixture',$1,false,false,0) RETURNING id v`, ['test_' + randomUUID()]);
const profile = async () => { const a = randomUUID(); await c.query('INSERT INTO profiles(id,credits) VALUES($1,7)', [a]); return a; };
const contract = p => ({ version: 1, item_type: 'membership_plan', item_id: p, item_updated_at: '2026-10-12T00:00:00Z',
  billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '19.99', discount: '0.00', tax_behavior: 'unspecified',
  credits: 100, bonus_credits: 0 });

/** One subscription row shaped like the channel writes it; returns its id. */
async function subscribe(user, { channel = null, stripeId = null, cancel = 'false', status = 'active', ref = true }) {
  const id = randomUUID(), p = await plan();
  await c.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,billing_cycle,status,
    cancel_at_period_end,current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
    VALUES($1,$2,$3,$4,'monthly',$5,$6,now(),now()+interval '1 month',$7,$8,$9,$10)`,
  [id, user, p, stripeId, status, cancel, channel, channel && 'acct_fixture', channel && 'test', channel && contract(p)]);
  if (channel && ref) {
    await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
      VALUES($1,'acct_fixture','test','subscription',$2,$3)`, [channel, 'sub_' + id.slice(0, 8), id]);
  }
  return id;
}
const preview = a => v('SELECT account_erasure_preview($1) v', [a]);
// confirm_with_digests (0204) only records identity digests, then calls this same confirm.
const confirm = a => v('SELECT account_erasure_confirm($1,$2) v', [a, randomUUID()]);
const pending = async a => (await v('SELECT account_erasure_financial_proof($1) v', [a])).financialPending;

async function expectBlocked(user, channels) {
  const p = await preview(user);
  assert.equal(p.subscriptionRenewing, true);
  assert.deepEqual(p.renewalChannels, channels);
  assert.ok(p.subscriptionActiveUntil);
  assert.ok(await pending(user) >= 1, 'a renewing subscription also keeps completion pending');
  await code(confirm(user), 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING');
  assert.equal(await v('SELECT count(*)::int v FROM account_erasure_requests WHERE profile_id=$1', [user]), 0);
  assert.equal(await v('SELECT status v FROM profiles WHERE id=$1', [user]), 'active');
}
async function expectAllowed(user) {
  const p = await preview(user);
  assert.equal(p.subscriptionRenewing, false);
  assert.deepEqual(p.renewalChannels, []);
  assert.equal((await confirm(user)).created, true);
  assert.equal(await v('SELECT status v FROM profiles WHERE id=$1', [user]), 'deleted');
}

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0224 reapplication after the full chain preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const f of ['account_erasure_renewing(uuid)', 'account_erasure_renewal_channels(uuid)', 'account_erasure_preview(uuid)']) {
      assert.equal(await v('SELECT has_function_privilege($1,$2,\'execute\') v', [role, f]), false, `${role} ${f}`);
    }
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','account_erasure_renewal_channels(uuid)','execute') v"), false);
  assert.equal(await v("SELECT has_function_privilege('service_role','account_erasure_preview(uuid)','execute') v"), true);
  report.checks.push('clients cannot call the renewal helpers; service_role keeps only the preview RPC');

  // Legacy Stripe subscription: deny while renewing, allow once the webhook synced cancel_at_period_end.
  const stripe = await profile(), stripeSub = await subscribe(stripe, { stripeId: 'sub_legacy_' + randomUUID().slice(0, 8) });
  await expectBlocked(stripe, ['stripe_portal']);
  await c.query("UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=$1", [stripeSub]);
  await expectAllowed(stripe);
  report.checks.push('legacy Stripe: deny while renewing, allow after cancel at period end (unchanged behaviour)');

  // Waffo card: no Stripe id. A requested but unconfirmed stop still renews; only the confirmed cancel allows.
  const waffo = await profile(), waffoSub = await subscribe(waffo, { channel: 'waffo' });
  await expectBlocked(waffo, ['waffo']);
  await c.query('UPDATE user_subscriptions SET method_cancel_requested_at=now(),method_cancel_dispatched_at=now() WHERE id=$1', [waffoSub]);
  await expectBlocked(waffo, ['waffo']);
  await c.query("UPDATE user_subscriptions SET cancel_at_period_end='true',method_cancel_confirmed_at=now() WHERE id=$1", [waffoSub]);
  await expectAllowed(waffo);
  report.checks.push('Waffo: deny while renewing and while a cancel is only requested; allow after the confirmed cancel');

  // Stripe Managed Payments international card: Stripe id only in payment_provider_refs.
  const mp = await profile(), mpSub = await subscribe(mp, { channel: 'stripe' });
  await expectBlocked(mp, ['stripe']);
  await c.query("UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=$1", [mpSub]);
  await expectAllowed(mp);
  report.checks.push('MP international card (no stripe_subscription_id): deny while renewing, allow after cancel');

  // Mainland card_cn differs from MP only in payment_orders.payment_method ('card_cn' needs the payment
  // window's migration). The rule reads no order column, so it holds before or after that migration;
  // the subscription is simulated as written without a provider ref yet (e.g. while the ref is pending).
  for (const f of ['account_erasure_renewing(uuid)', 'account_erasure_renewal_channels(uuid)', 'account_erasure_preview(uuid)']) {
    const src = await v('SELECT prosrc v FROM pg_proc WHERE oid=$1::regprocedure', [f]);
    assert.doesNotMatch(src, /payment_method|auto_renew|stripe_managed_payments|payment_provider_refs/, f);
  }
  const cn = await profile(), cnSub = await subscribe(cn, { channel: 'stripe', ref: false });
  await expectBlocked(cn, ['stripe']);
  await c.query("UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=$1", [cnSub]);
  await expectAllowed(cn);
  report.checks.push('mainland card_cn (no provider ref, no Stripe id): deny while renewing, allow after cancel');

  // Two renewing subscriptions on different channels each name their own cancel entry.
  const mixed = await profile();
  await subscribe(mixed, { stripeId: 'sub_mixed_' + randomUUID().slice(0, 8) });
  await subscribe(mixed, { channel: 'waffo' });
  await expectBlocked(mixed, ['stripe_portal', 'waffo']);
  report.checks.push('mixed channels: every renewing channel is listed for the cancel hint');

  // Non-renewing paid access (wallet annual is inserted with cancel_at_period_end='true') never blocks,
  // but its paid end is still shown; ended subscriptions show nothing.
  const wallet = await profile();
  await subscribe(wallet, { channel: 'stripe', cancel: 'true', ref: false });
  const walletPreview = await preview(wallet);
  assert.equal(walletPreview.subscriptionRenewing, false);
  assert.ok(walletPreview.subscriptionActiveUntil, 'paid access end covers non-Stripe-id subscriptions');
  await expectAllowed(wallet);
  const ended = await profile();
  await subscribe(ended, { channel: 'waffo', status: 'canceled' });
  assert.equal((await preview(ended)).subscriptionActiveUntil, null);
  await expectAllowed(ended);
  report.checks.push('allow: non-renewing and ended subscriptions; paid access end covers every channel');

  // Recovery: the rollback restores the pre-0224 catalog exactly; reapplying 0224 restores the fix.
  const rollbackUser = await profile();
  await subscribe(rollbackUser, { channel: 'waffo' });
  const fixed = await v(catalogSql);
  await c.query(read('packages/db/tests/erasure-renewal/rollback.sql'));
  assert.equal((await preview(rollbackUser)).subscriptionRenewing, false, 'old rule misses Waffo (the bug)');
  assert.equal((await preview(rollbackUser)).renewalChannels, undefined);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), fixed);
  await expectBlocked(rollbackUser, ['waffo']);
  report.checks.push('rollback restores the old definitions without data changes; reapplying 0224 restores the block');

  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit still returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
