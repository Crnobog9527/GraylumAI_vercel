/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {addUtcMonths} from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Real local PostgreSQL: one-time wallet upgrade, policy boundaries, failure, replay and concurrency. */
export async function walletMembershipCases({ admin, service, connect }) {
  await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760`);
  const plans = (await admin.query("SELECT id,level FROM membership_plans WHERE level IN ('pro','gold')")).rows;
  const pro = plans.find(p => p.level === 'pro').id, gold = plans.find(p => p.level === 'gold').id;
  const original = (await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version = original.version + 1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'", [{ ...original, version,
    wechat_pay: { enabled: true, annualVerified: true }, alipay: { enabled: true, annualVerified: true } }]);
  for (const [plan, cycle, offer] of [[pro, 'monthly', 'standard'], [gold, 'monthly', 'gold_first30'],
    [pro, 'yearly', 'standard'], [gold, 'yearly', 'standard'], [gold, 'monthly', 'standard'], [gold, 'yearly', 'founder']]) {
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
      VALUES('stripe','fixture','test','price',$1,$2,$3,true,$4,'one_time') ON CONFLICT DO NOTHING`,
    [`price_wallet_regression_${plan}_${cycle}_${offer}`, plan, cycle, offer]);
  }
  const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
  const buy = async (user, method, plan = pro, cycle = 'monthly', offer = 'standard', prior = null, transition = 'upgrade') => {
    const digests = JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: user.replaceAll('-', '').repeat(2) }]);
    return prior ? one(service,
      `SELECT o.* FROM pay_waffo_create_transition($1,$2,$3,$4,$5,'fixture',$6,'terms-v1',$7,$9,$8) o`,
      [user, plan, cycle, method, offer, version, digests, prior, transition]) : one(service,
      `SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,'fixture','test',$6,'terms-v1',$7) o`,
      [user, plan, cycle, method, offer, version, digests]);
  };
  const actor = async () => {
    const user = randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [user]); return user;
  };
  const bind = async o => {
    const expiry = new Date(Date.now() + 1800000);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)', [o.user_id, o.id, 'fixture',
      { orderId: o.id, userId: o.user_id, method: o.payment_method, merchant: 'fixture', mode: 'test',
        providerRequest: { fixture: true } }, expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)', [o.user_id, o.id, 'fixture', `cs_${o.id}`, expiry]);
  };
  const start = new Date(Math.floor(Date.now() / 1000) * 1000);
  const pay = async (db, o, from = start, paidAt = start) => {
    const end = o.entitlement_term === 'days30' ? new Date(new Date(from).getTime() + 30 * 86400000)
      : (await one(admin, `SELECT (($1::timestamptz AT TIME ZONE 'UTC')+make_interval(months=>$2))
        AT TIME ZONE 'UTC' v`, [from, o.billing_cycle === 'yearly' ? 12 : 1])).v;
    return one(db, 'SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9) v',
      [o.id, 'fixture', `cs_${o.id}`, `pi_${o.id}`, o.amount_total, 'usd', paidAt, from, end]);
  };
  const profile = user => one(admin, 'SELECT credits,membership_level FROM profiles WHERE id=$1', [user]);
  const a = await connect(), b = await connect();
  await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
  for (const [method, next, targetCycle] of [['wechat_pay', 'alipay', 'monthly'], ['alipay', 'wechat_pay', 'monthly'],
    ['wechat_pay', 'alipay', 'yearly'], ['alipay', 'wechat_pay', 'yearly']]) {
    const user = await actor(), initial = await buy(user, method);
    await bind(initial);
    const paid = (await pay(service, initial)).v;
    assert.equal(paid.state, 'fulfilled');
    const state = await one(admin, 'SELECT cancel_at_period_end FROM user_subscriptions WHERE id=$1', [paid.subscriptionId]);
    assert.equal(state.cancel_at_period_end, 'true', 'wallet never auto-renews');
    const own = await connect();
    await own.query('BEGIN');
    await own.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user]);
    await own.query('SET LOCAL ROLE authenticated');
    const ownFacts = (await one(own, 'SELECT pay_common_membership_facts($1) v', [user])).v.internal_membership;
    assert.equal(ownFacts.payment_method, method, 'authorized facts include the frozen method');
    await assert.rejects(() => own.query('SELECT payment_method FROM payment_orders WHERE id=$1', [initial.id]), /permission denied/);
    await own.query('ROLLBACK');
    await own.query('BEGIN');
    await own.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user]);
    await own.query('SET LOCAL ROLE authenticated');
    await assert.rejects(() => own.query('SELECT pay_common_membership_facts($1)', [randomUUID()]), /FACTS_ACCESS_DENIED/);
    await own.query('ROLLBACK');
    // A second ordinary checkout still cannot bypass the controlled renewal/upgrade paths.
    await assert.rejects(() => buy(user, next, pro, 'yearly'), /MEMBERSHIP_TRANSITION_REQUIRED/);
    await assert.rejects(() => buy(user, next, pro, 'monthly'), /MEMBERSHIP_TRANSITION_REQUIRED/);
    const offer = targetCycle === 'yearly' ? 'standard' : 'gold_first30';
    const upgrade = await buy(user, next, gold, targetCycle, offer, paid.subscriptionId);
    assert.equal((await buy(user, next, gold, targetCycle, offer, paid.subscriptionId)).id, upgrade.id);
    assert.deepEqual(await profile(user), { credits: 3480, membership_level: 'pro' }, 'unpaid upgrade changes nothing');
    await bind(upgrade);
    const results = await Promise.all([pay(a, upgrade), pay(b, upgrade)]);
    assert.equal(results.filter(r => r.v.duplicate === false).length, 1);
    assert.equal((await pay(service, upgrade)).v.duplicate, true);
    assert.deepEqual(await profile(user), { credits: 12450, membership_level: 'gold' });
    const source = await one(admin, 'SELECT credit_release_terminated_at FROM user_subscriptions WHERE id=$1', [paid.subscriptionId]);
    assert.equal(source.credit_release_terminated_at, null, 'old paid credits are retained');
    const refs = await one(admin, `SELECT count(*)::int n FROM payment_provider_refs WHERE subscription_id=$1
      AND object_type='subscription'`, [paid.subscriptionId]);
    assert.equal(refs.n, 0, 'wallet has an internal membership, no recurring Stripe subscription');
  }
  // Owner A: both wallet methods, both levels, same-level annual change and monthly advance renewal.
  const renew = (user, method, plan, cycle, prior, offer = 'standard') =>
    buy(user, method, plan, cycle, offer, prior, 'wallet_renewal');
  const operator = await actor();
  await admin.query("UPDATE profiles SET role='admin' WHERE id=$1", [operator]);
  async function refundRenewal(user, order, paidAt, status) {
    const ticket = (await one(admin, "INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id", [user])).id;
    const cash = { orderId: order.id, merchant: 'fixture', mode: 'test', currency: 'usd', paymentIntentId: `pi_${order.id}`,
      chargeId: `ch_${order.id}`, paidMinor: order.amount_total, taxMinor: 0, paidAt: paidAt.toISOString(),
      refundedMinor: 0, refundCount: 0, disputed: false };
    const args = [operator, order.id, ticket, cash, 'not_permitted', 'legal:fixture'];
    const q = (await one(service, 'SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,$6) v', args)).v;
    assert.equal(q.credits, 0, 'a future renewal with no releases remains refundable');
    const intent = (await one(service, "SELECT pay_common_package_refund_decide($1,$2,$3,$4,$5,$6,$7,'approve') v",
      [...args, q.versionHash])).v;
    await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)', [operator, order.id, intent.id, cash]);
    const receipt = { id: `re_${intent.id}`, intentId: intent.id, orderId: order.id, paymentIntentId: cash.paymentIntentId,
      chargeId: cash.chargeId, currency: 'usd', amount: q.netMinor, mode: 'test', merchant: 'fixture', status };
    await service.query('SELECT pay_common_package_refund_result($1,$2,$3)', [order.id, intent.id, receipt]);
    await service.query('SELECT pay_common_package_refund_result($1,$2,$3)', [order.id, intent.id, receipt]);
  }
  for (const method of ['wechat_pay', 'alipay']) for (const plan of [pro, gold]) for (const cycle of ['monthly', 'yearly']) {
    const user = await actor(), initial = await buy(user, method, plan);
    await bind(initial);
    const first = (await pay(service, initial)).v;
    const source = await one(admin, 'SELECT entitlement_start,entitlement_end FROM payment_orders WHERE id=$1', [initial.id]);
    const before = await profile(user), next = method === 'alipay' ? 'wechat_pay' : 'alipay';
    const renewal = await renew(user, next, plan, cycle, first.subscriptionId);
    assert.equal((await renew(user, next, plan, cycle, first.subscriptionId)).id, renewal.id, 'pending renewal is reused');
    const stranger = await actor();
    await assert.rejects(() => renew(stranger, next, plan, cycle, first.subscriptionId), /TRANSITION_DENIED/);
    await bind(renewal);
    await assert.rejects(() => pay(service, renewal), /TERM_INVALID/, 'cannot start a renewal at its payment time');
    const delivered = await Promise.all([pay(a, renewal, source.entitlement_end), pay(b, renewal, source.entitlement_end)]);
    assert.equal(delivered.filter(r => r.v.duplicate === false).length, 1);
    assert.equal((await pay(service, renewal, source.entitlement_end)).v.duplicate, true);
    assert.deepEqual(await profile(user), before, 'advance payment neither adds credits nor changes current access');
    assert.equal((await one(admin, 'SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1', [renewal.id])).n, 0);
    const term = await one(admin, 'SELECT entitlement_start,entitlement_end FROM payment_orders WHERE id=$1', [renewal.id]);
    assert.equal(term.entitlement_start.toISOString(), source.entitlement_end.toISOString(), 'no paid time is lost');
    const facts = (await one(service, 'SELECT pay_common_membership_facts($1) v', [user])).v.internal_membership;
    assert.equal(facts.id, first.subscriptionId, 'future paid term does not replace current membership');
    const old = await one(admin, 'SELECT entitlement_start,entitlement_end FROM payment_orders WHERE id=$1', [initial.id]);
    assert.deepEqual(old, source, 'source term remains unchanged');
    await assert.rejects(() => renew(user, next, plan, cycle, first.subscriptionId), /TRANSITION_DENIED/, 'stale source cannot overlap paid renewal');
    // MAINT-P1b: the concurrent delivery that lost returns {duplicate:true} without ids; take the one that delivered.
    const queued = delivered.find(r => r.v.duplicate === false).v.subscriptionId;
    await assert.rejects(() => renew(user, 'card', plan, cycle, queued), /TRANSITION_DENIED/, 'card cannot enter wallet renewal');
    await assert.rejects(() => renew(user, next, plan === pro ? gold : pro, cycle, queued), /TRANSITION_DENIED/, 'no tier change in ordinary renewal');
    const second = await renew(user, method, plan, 'monthly', queued);
    await bind(second); await pay(service, second, term.entitlement_end);
    assert.deepEqual(await profile(user), before, 'a second prepaid term still grants no early credits');
    await assert.rejects(() => renew(user, 'card', plan, cycle, queued), /TRANSITION_DENIED/, 'card cannot enter wallet renewal');
    await assert.rejects(() => renew(user, next, plan === pro ? gold : pro, cycle, queued), /TRANSITION_DENIED/, 'no tier change in ordinary renewal');
  }
  const founderUser = await actor(), founder = await buy(founderUser, 'alipay', gold, 'yearly', 'founder');
  await bind(founder);
  const founderPaid = (await pay(service, founder)).v;
  await assert.rejects(() => renew(founderUser, 'wechat_pay', gold, 'monthly', founderPaid.subscriptionId), /TRANSITION_DENIED/);
  const founderNext = await buy(founderUser, 'wechat_pay', gold, 'yearly', 'founder_renewal', founderPaid.subscriptionId, 'founder_renewal');
  assert.equal(founderNext.amount_total, 49600, 'existing founder renewal price is unchanged');
  await bind(founderNext);
  const founderEnd = (await one(admin, 'SELECT entitlement_end FROM payment_orders WHERE id=$1', [founder.id])).entitlement_end;
  assert.equal((await pay(service, founderNext, founderEnd)).v.state, 'fulfilled', 'existing founder renewal still appends');
  assert.deepEqual(await profile(founderUser), { credits: 8970, membership_level: 'gold' });
  for (const status of ['succeeded', 'failed']) {
    const user = await actor(), initial = await buy(user, 'wechat_pay');
    await bind(initial);
    const first = (await pay(service, initial)).v;
    const original = await one(admin, 'SELECT entitlement_start,entitlement_end FROM payment_orders WHERE id=$1', [initial.id]);
    const renewal = await renew(user, 'alipay', pro, 'yearly', first.subscriptionId);
    await bind(renewal); await pay(service, renewal, original.entitlement_end);
    await refundRenewal(user, renewal, start, status);
    assert.deepEqual(await profile(user), { credits: 3480, membership_level: 'pro' }, 'future refund never changes old credits or access');
    assert.deepEqual(await one(admin, 'SELECT entitlement_start,entitlement_end FROM payment_orders WHERE id=$1', [initial.id]), original);
    const state = await one(admin, `SELECT s.credit_release_terminated_at,s.status FROM user_subscriptions s
      JOIN payment_orders o ON o.subscription_id=s.id WHERE o.id=$1`, [renewal.id]);
    assert.equal(state.status, status === 'succeeded' ? 'canceled' : 'active');
    assert.equal(state.credit_release_terminated_at === null, status === 'failed');
  }
  // A real wall-clock boundary proves the existing cron releases future monthly/yearly terms exactly once.
  // Backdate only local fixture created_at. Calendar months are not fixed 30-day intervals.
  const priorPeriod = end => {
    let paid = new Date(end);
    paid.setTime(addUtcMonths(paid,-1));
    // A month cannot end on October 31 if it started in September. An annual source can;
    // February 29 always has a January 29 monthly source, so the annual fallback never loses leap day.
    const cycle = paid.getUTCDate() === end.getUTCDate() ? 'monthly' : 'yearly';
    if (cycle === 'yearly') { paid = new Date(end); paid.setUTCFullYear(paid.getUTCFullYear() - 1); }
    return { paid, cycle };
  };
  for (const value of ['2026-10-31T08:00:00Z', '2026-11-21T08:00:00Z', '2028-02-29T08:00:00Z']) {
    const end = new Date(value), prior = priorPeriod(end);
    const actual = (await one(admin, `SELECT (($1::timestamptz AT TIME ZONE 'UTC')+make_interval(months=>$2))
      AT TIME ZONE 'UTC' v`, [prior.paid, prior.cycle === 'yearly' ? 12 : 1])).v;
    assert.equal(actual.toISOString(), end.toISOString(), 'calendar fixture round-trips at month ends and leap day');
  }
  for (const cycle of ['monthly', 'yearly']) {
    const expectedEnd = new Date(Date.now() + 5000), prior = priorPeriod(expectedEnd);
    const user = await actor(), initial = await buy(user, 'alipay', gold, prior.cycle);
    const originalPaid = prior.paid;
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1', [initial.id, new Date(originalPaid.getTime() - 60000)]);
    await bind(initial);
    const first = (await pay(service, initial, originalPaid, originalPaid)).v;
    const originalBalance = await profile(user);
    const source = await one(admin, 'SELECT entitlement_end FROM payment_orders WHERE id=$1', [initial.id]);
    assert.equal(source.entitlement_end.toISOString(), expectedEnd.toISOString(), 'source ends at the intended short boundary');
    const renewal = await renew(user, 'wechat_pay', gold, cycle, first.subscriptionId);
    await bind(renewal); await pay(service, renewal, source.entitlement_end);
    const count = () => one(admin, 'SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1', [renewal.id]);
    await service.query('SELECT pay_waffo_release_due(500)');
    assert.equal((await count()).n, 0, 'cron cannot release before original expiry');
    const delay = source.entitlement_end.getTime() - Date.now() + 50;
    assert.ok(delay >= 0 && delay <= 5500, 'wall-clock boundary cannot turn into a days-long wait');
    await new Promise(resolve => setTimeout(resolve, delay));
    await Promise.all([a.query('SELECT pay_waffo_release_due(500)'), b.query('SELECT pay_waffo_release_due(500)')]);
    await service.query('SELECT pay_waffo_release_due(500)');
    assert.equal((await count()).n, 1, 'new period gets one due grant, no annual months prepaid');
    assert.deepEqual(await profile(user), { credits: originalBalance.credits + 8970, membership_level: 'gold' });
    const facts = (await one(service, 'SELECT pay_common_membership_facts($1) v', [user])).v.internal_membership;
    assert.equal(facts.id, (await one(admin, 'SELECT subscription_id FROM payment_orders WHERE id=$1', [renewal.id])).subscription_id);
  }
  // An authoritative closed unpaid Alipay session releases the order but grants neither membership nor credits.
  for (const method of ['wechat_pay', 'alipay']) {
    const user = await actor(), order = await buy(user, method);
    await bind(order);
    const attemptFailed = () => service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,
      'failed_attempt_unpaid',$3,0,'usd',NULL)`, [order.id, `cs_${order.id}`, `pi_${order.id}`]);
    await attemptFailed(); await attemptFailed();
    assert.deepEqual(await profile(user), { credits: 0, membership_level: 'free' });
    const state = await one(admin, `SELECT qualification_state,purchase_closed_at,method_review_reason FROM payment_orders WHERE id=$1`, [order.id]);
    assert.deepEqual(state, { qualification_state: 'reserved', purchase_closed_at: null, method_review_reason: 'wallet_payment_failed' },
      'an unpaid failed attempt is visible immediately but remains safely retryable');
    assert.equal((await buy(user, method)).id, order.id, 'retry reuses the original checkout order');
    assert.equal((await pay(service, order)).v.state, 'fulfilled', 'verified success after failure still delivers normally');
    await attemptFailed();
    assert.equal((await one(admin, 'SELECT method_review_reason FROM payment_orders WHERE id=$1', [order.id])).method_review_reason, null,
      'verified paid retry clears the display marker, and late failure cannot overwrite it');
    assert.deepEqual(await profile(user), { credits: 3480, membership_level: 'pro' });
  }
  const failedUser = await actor(), failed = await buy(failedUser, 'alipay');
  await bind(failed);
  const close = () => service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,
    'failed_unpaid',NULL,0,'usd',NULL)`, [failed.id, `cs_${failed.id}`]);
  await close(); await close();
  await assert.rejects(() => service.query("UPDATE payment_orders SET method_review_reason='forbidden' WHERE id=$1", [failed.id]),
    /permission denied/, 'service role still cannot directly write protected evidence');
  assert.equal((await one(admin, 'SELECT method_review_reason FROM payment_orders WHERE id=$1', [failed.id])).method_review_reason,
    'async_payment_failed');
  assert.deepEqual(await profile(failedUser), { credits: 0, membership_level: 'free' });
  assert.equal((await one(admin, 'SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1', [failed.id])).n, 0);
  assert.equal((await pay(service, failed)).v.state, 'review', 'a late payment remains review, never silently delivered');
  await assert.rejects(close, /NOT_TERMINAL_UNPAID/, 'a delayed failure cannot overwrite paid evidence');
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'", [{ ...original, version: version + 1 }]);
  return ['wallet-both-methods-upgrade', 'wallet-upgrade-replay-concurrent-once', 'wallet-original-credits-preserved',
    'wallet-same-level-annual-change-appends', 'wallet-advance-monthly-appends', 'wallet-renewal-replay-concurrency-once',
    'wallet-renewal-chained-source-no-overlap', 'wallet-renewal-no-early-credits', 'wallet-renewal-due-cron-monthly-yearly-once',
    'wallet-renewal-cards-cross-user-tier-change-denied', 'wallet-renewal-founder-unchanged',
    'wallet-renewal-zero-credit-refund-success-and-failure', 'wallet-failure-attempt-no-early-release-retry-success',
    'wallet-failure-no-membership-no-credits', 'wallet-late-cash-review'];
}
