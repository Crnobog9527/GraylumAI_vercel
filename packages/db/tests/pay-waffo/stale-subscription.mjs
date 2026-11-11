/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { addUtcMonths, latestMonthEnd } from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STALE-SUB (2026-11-08): a Stripe subscription that stayed renewing after its period because its final event was
 * lost (or, for a legacy subscription, no longer handled). Facts grant nothing, admission still refuses as a member.
 * staleSubscriptionRefresh.ts re-reads Stripe and applies the state through the webhook's own sync functions; these
 * cases pin what those functions do to admission: normal, stale, duplicate, concurrent and late events. */
export async function staleSubscriptionCases({ admin, service, connect }) {
  const gold = (await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const pro = (await admin.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
  const current = (await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version = current.version + 1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{ ...current, card: { enabled: true }, alipay: { enabled: true, annualVerified: true }, version }]);
  const digests = user => JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: user.replaceAll('-', '').repeat(2) }]);
  const buy = (db, user, plan = pro, method = 'alipay') => db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,
    'membership_plan',$2,'monthly',$3,'standard','fixture','test',$4,'terms-v1',$5) o`, [user, plan, method, version, digests(user)]);
  const level = async user => (await admin.query('SELECT membership_level FROM profiles WHERE id=$1', [user])).rows[0].membership_level;
  const status = async sub => (await admin.query('SELECT status FROM user_subscriptions WHERE id=$1', [sub])).rows[0].status;
  const orders = async user => (await admin.query("SELECT count(*)::int n FROM payment_orders WHERE user_id=$1", [user])).rows[0].n;
  const deliver = async (user, o, start, end) => {
    const expiry = new Date(Date.now() + 1800000), checkout = `cs_${o.id}`, card = o.payment_method === 'card';
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)', [user, o.id, 'fixture',
      { orderId: o.id, userId: user, method: o.payment_method, merchant: 'fixture', mode: 'test', providerRequest: { fixture: true } },
      expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)', [user, o.id, 'fixture', checkout, expiry]);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1', [o.id, new Date(start.getTime() - 60000)]);
    const paid = (await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v', [o.id, 'fixture',
      checkout, `in_stale_${o.id.slice(0, 8)}`, o.amount_total, 'usd', card ? new Date(start.getTime() + 6000) : start,
      card ? `sub_${o.id}` : null, start, end])).rows[0].v;
    assert.equal(paid.state, 'fulfilled', JSON.stringify(paid));
    return paid.subscriptionId;
  };
  const newUser = async (membership = 'free') => {
    const user = randomUUID();
    await admin.query('INSERT INTO profiles(id,credits,membership_level) VALUES($1,0,$2)', [user, membership]);
    return user;
  };
  // A Gold card subscription whose month ended `hoursAgo` hours ago and that still reads active (no final event).
  const goldCard = async hoursAgo => {
    const user = await newUser();
    const end = latestMonthEnd(new Date(Math.floor(Date.now() / 1000) * 1000 - hoursAgo * 3600000));
    const sub = await deliver(user, (await buy(service, user, gold, 'card')).rows[0], addUtcMonths(end, -1), end);
    await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1", [user]);
    return { user, sub };
  };
  // What refreshStaleSubscription applies for a card subscription Stripe has ended (handleCardSubscriptionState).
  const mpCanceled = sub => service.query("SELECT pay_stripe_mp_sync_subscription($1,'fixture',false,true,false)", [sub]);
  const freshPro = async user => {
    const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
    return deliver(user, (await buy(service, user)).rows[0], start, addUtcMonths(start, 1));
  };

  // Normal: a current card subscription keeps blocking a second purchase.
  const live = await goldCard(-24 * 20);
  await assert.rejects(() => buy(service, live.user), /PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED/);
  assert.equal(await orders(live.user), 1);

  // Stale: three days past the period, still "active" locally. Facts already grant nothing, yet admission refuses:
  // this is the reported lockout. Once Stripe's cancellation is applied, the purchase opens.
  const stale = await goldCard(72);
  await assert.rejects(() => buy(service, stale.user), /PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED/);
  assert.equal((await service.query('SELECT pay_common_membership_facts($1) v', [stale.user])).rows[0].v
    .internal_membership.mapping_state, 'internal_inactive', 'facts grant nothing after the 24-hour grace');
  await mpCanceled(stale.sub);
  // Duplicate: the webhook and the daily refresh may both apply it; the second changes nothing.
  await mpCanceled(stale.sub);
  assert.equal(await status(stale.sub), 'canceled');
  // Concurrency: two purchase attempts at once (two connections) admit one order; the twin gets the same intent.
  const [a, b] = [await connect(), await connect()];
  await Promise.all([a, b].map(c => c.query('SET ROLE service_role')));
  const twins = await Promise.all([buy(a, stale.user), buy(b, stale.user)]);
  assert.equal(twins[0].rows[0].id, twins[1].rows[0].id, 'concurrent identical purchases share one order');
  assert.equal(await orders(stale.user), 2);
  // A different plan while that order is open is refused, never a second checkout.
  await assert.rejects(() => buy(service, stale.user, gold, 'card'), /PAY_WAFFO_PURCHASE_PENDING/);
  const order = twins[0].rows[0];
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  const renewed = await deliver(stale.user, order, start, addUtcMonths(start, 1));
  assert.equal(await level(stale.user), 'pro');
  // Late: the old subscription's cancellation replayed after the new purchase leaves the new membership alone.
  await mpCanceled(stale.sub);
  assert.equal(await status(renewed), 'active');
  assert.equal(await level(stale.user), 'pro');

  // Legacy (D17, before PAY-STRIPE-MP; staging data only): stopped at period end, ended, profile still pro, no paid
  // order of the new paths. Its events are unclaimed since ARCH-FIX F2, so only the refresh can apply Stripe's end.
  const legacy = async () => {
    const user = await newUser('pro'), sub = randomUUID(), external = `sub_legacy_${sub.slice(0, 8)}`;
    const end = new Date(Date.now() - 5 * 86400000);
    await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,current_period_start,
      current_period_end,cancel_at_period_end,stripe_subscription_id,stripe_customer_id,payment_channel,payment_mode,
      merchant_namespace,contract_snapshot) SELECT $1,$2,$3,'monthly','active',$4,$5,'true',$6,$7,'stripe','test','fixture',
      contract_snapshot FROM user_subscriptions WHERE id=$8`,
    [sub, user, pro, addUtcMonths(end, -1), end, external, `cus_legacy_${sub.slice(0, 8)}`, renewed]);
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
      VALUES('stripe','fixture','test','subscription',$1,$2)`, [external, sub]);
    return { user, sub, external, start: addUtcMonths(end, -1) };
  };
  // What refreshStaleSubscription applies for a legacy subscription (syncSubscriptionState).
  const legacyCanceled = f => service.query("SELECT pay_common_sync_subscription('fixture','test',$1) v", [{ id: f.external,
    object: 'subscription', livemode: false, user_id: f.user, customer: `cus_legacy_${f.sub.slice(0, 8)}`, status: 'canceled',
    cancel_at_period_end: 'true', period_start: f.start.toISOString() }]);
  const old = await legacy();
  await assert.rejects(() => buy(service, old.user), /PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED/);
  assert.equal(await level(old.user), 'pro', 'settle never lowers a legacy-only buyer');
  assert.equal((await legacyCanceled(old)).rows[0].v, true);
  assert.equal((await legacyCanceled(old)).rows[0].v, true, 'a duplicate cancellation is accepted');
  assert.equal(await level(old.user), 'free');
  const legacyNew = await freshPro(old.user);
  // Late legacy cancellation after the new purchase: the new subscription keeps the level.
  await legacyCanceled(old);
  assert.equal(await status(legacyNew), 'active');
  assert.equal(await level(old.user), 'pro');

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'", [{ ...current, version: version + 1 }]);
  return ['stale-sub-current-blocks', 'stale-sub-ended-blocks-until-applied', 'stale-sub-duplicate-cancel',
    'stale-sub-concurrent-purchase-one-order', 'stale-sub-late-cancel-keeps-new', 'stale-sub-legacy-applied',
    'stale-sub-legacy-late-cancel-keeps-new'];
}
