/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
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
    [pro, 'yearly', 'standard'], [gold, 'yearly', 'standard']]) {
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
      VALUES('stripe','fixture','test','price',$1,$2,$3,true,$4,'one_time') ON CONFLICT DO NOTHING`,
    [`price_wallet_regression_${plan}_${cycle}_${offer}`, plan, cycle, offer]);
  }
  const one = async (db, sql, args) => (await db.query(sql, args)).rows[0];
  const buy = async (user, method, plan = pro, cycle = 'monthly', offer = 'standard', prior = null) => {
    const digests = JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: user.replaceAll('-', '').repeat(2) }]);
    return prior ? one(service,
      `SELECT o.* FROM pay_waffo_create_transition($1,$2,$3,$4,$5,'fixture',$6,'terms-v1',$7,'upgrade',$8) o`,
      [user, plan, cycle, method, offer, version, digests, prior]) : one(service,
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
  const pay = (db, o) => {
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + (o.billing_cycle === 'yearly' ? 12 : 1));
    return one(db, 'SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,NULL,$7,$8) v',
      [o.id, 'fixture', `cs_${o.id}`, `pi_${o.id}`, o.amount_total, 'usd', start, end]);
  };
  const profile = user => one(admin, 'SELECT credits,membership_level FROM profiles WHERE id=$1', [user]);
  const a = await connect(), b = await connect();
  await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
  for (const [method, next] of [['wechat_pay', 'alipay'], ['alipay', 'wechat_pay']]) {
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
    // No approved same-level monthly -> annual/advance-renewal policy: never bypass admission with ordinary checkout.
    await assert.rejects(() => buy(user, next, pro, 'yearly'), /MEMBERSHIP_TRANSITION_REQUIRED/);
    await assert.rejects(() => buy(user, next, pro, 'monthly'), /MEMBERSHIP_TRANSITION_REQUIRED/);
    const upgrade = await buy(user, next, gold, 'monthly', 'gold_first30', paid.subscriptionId);
    assert.equal((await buy(user, next, gold, 'monthly', 'gold_first30', paid.subscriptionId)).id, upgrade.id);
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
  // An authoritative closed unpaid Alipay session releases the order but grants neither membership nor credits.
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
    'wallet-same-level-year-change-policy-not-bypassed', 'wallet-failure-no-membership-no-credits', 'wallet-late-cash-review'];
}
