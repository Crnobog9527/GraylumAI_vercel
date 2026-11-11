/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Deep review 2026-11-11 item 5 (migration 9999): a WeChat Pay / Alipay credit pack refunded outside Graylum is recorded like
 * a card pack (Owner 2026-10-14: record only, a person settles): full refund -> 'pack_review', the pack's credits held, the
 * manual settlement (item 14 entry) takes back or keeps them once. Before, an undisputed wallet pack was refused here and
 * fell to the old path (nothing recorded, nothing held, no alert). */
export async function walletPackExternalRefundCases({ admin, service, connect }) {
  const ops = randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')", [ops]);
  // A paid wallet pack, granted the way pay_waffo_fulfill_payment grants it ('method-package:'), with its payment reference.
  const pack = async (method, credits = 2990, balance = credits) => {
    const user = randomUUID(), item = randomUUID(), order = randomUUID(), payment = 'pi_' + order.replaceAll('-', '');
    await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [user]);
    await admin.query('INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES($1,$2,$3,2990,0)',
      [item, 'Wallet pack ' + item, credits]);
    const snap = { version: 1, item_type: 'credit_package', item_id: item, item_updated_at: '2026-10-01T00:00:00Z',
      billing_cycle: 'one_time', currency: 'usd', unit: 'major', price: '29.90', discount: '0.00', tax_behavior: 'exclusive',
      credits, bonus_credits: 0 };
    await admin.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
      payment_channel,merchant_namespace,payment_mode,payment_method,purchase_request_id,purchase_payload_hash,purchase_snapshot,
      amount_total,currency,fulfilled_at,routing_version,terms_version,terms_accepted_at,auto_renew,offer_kind,qualification_state)
      VALUES($1,$2,'credit_package',$3,'one_time','payment','completed','paid','stripe','fixture','test',$4,gen_random_uuid(),
      repeat('b',64),$5,2990,'usd',now(),1,'terms-v1',now(),false,'standard','sold')`, [order, user, item, method, snap]);
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
      VALUES('stripe','fixture','test','payment',$1,$2)`, [payment, order]);
    await admin.query('UPDATE profiles SET credits=$2 WHERE id=$1', [user, balance]);
    await admin.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key)
      VALUES($1,$2,'purchase','grant',$3,$4)`, [user, credits, order, 'method-package:' + order]);
    return { user, order, payment };
  };
  const record = (p, refund, amount = 2990, db = service) => db.query(
    `SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',now()) v`, [p.order, p.payment, refund, amount]);
  const held = async p => (await admin.query(`SELECT credit_package_refund_held(s.id) v FROM credit_package_sources s
    WHERE s.order_id=$1`, [p.order])).rows[0].v;
  const balance = async p => (await admin.query('SELECT credits FROM profiles WHERE id=$1', [p.user])).rows[0].credits;
  const settle = (actor, p, decision) => service.query('SELECT pay_common_pack_refund_review_settle($1,$2,$3) v', [actor, p.order, decision]);

  for (const method of ['alipay', 'wechat_pay']) {
    // Full external refund: recorded for review, order ended, credits held (not taken), never twice.
    const p = await pack(method);
    const first = (await record(p, `re_full_${method}`)).rows[0].v;
    assert.deepEqual([first.state, first.duplicate, first.packCredits, first.balance], ['pack_review', false, 2990, 2990], method);
    assert.deepEqual((await admin.query('SELECT status,payment_status FROM payment_orders WHERE id=$1', [p.order])).rows[0],
      { status: 'refunded', payment_status: 'refunded' });
    assert.equal(await held(p), true, 'the pack credits are held for a person');
    assert.equal(await balance(p), 2990, 'nothing taken automatically (Owner 2026-10-14)');
    const again = (await record(p, `re_full_${method}`)).rows[0].v;
    assert.deepEqual([again.state, again.duplicate], ['pack_review', true], 'a replay repeats the review state, records nothing');
    assert.equal((await admin.query(`SELECT jsonb_array_length(payment_amount_facts) n FROM payment_orders WHERE id=$1`,
      [p.order])).rows[0].n, 1, 'one refund fact');
    // Settlement: an ordinary user is refused; the admin's clawback takes the unused credits back once.
    await assert.rejects(() => settle(p.user, p, 'clawback'), /PAY_PACK_REVIEW_ADMIN_REQUIRED/);
    const taken = (await settle(ops, p, 'clawback')).rows[0].v;
    assert.deepEqual([taken.creditsTakenBack, taken.creditsShortfall, await balance(p)], [2990, 0, 0]);
    assert.equal((await settle(ops, p, 'clawback')).rows[0].v.duplicate, true);
    await assert.rejects(() => settle(ops, p, 'kept'), /PAY_PACK_REVIEW_CONFLICT/, 'a decision is never changed');
    assert.equal(await held(p), false);
  }
  // Partial external refund: recorded for review, the pack stays, nothing held.
  const partial = await pack('alipay');
  assert.equal((await record(partial, 're_partial', 1000)).rows[0].v.state, 'partial_review');
  assert.equal(await held(partial), false);
  assert.equal(await balance(partial), 2990);
  // "kept": the hold is released and the credits are ordinary balance.
  const kept = await pack('wechat_pay', 2990, 3100);
  await record(kept, 're_kept');
  assert.equal((await settle(ops, kept, 'kept')).rows[0].v.creditsTakenBack, 0);
  assert.deepEqual([await held(kept), await balance(kept)], [false, 3100]);
  // Concurrency: the webhook and the reconciliation record the same refund at once: one record, one review.
  const race = await pack('alipay');
  const [a, b] = [await connect(), await connect()];
  await Promise.all([a, b].map(c => c.query('SET ROLE service_role')));
  const both = (await Promise.all([record(race, 're_race', 2990, a), record(race, 're_race', 2990, b)])).map(r => r.rows[0].v);
  assert.deepEqual(both.map(r => r.state), ['pack_review', 'pack_review']);
  assert.equal(both.filter(r => r.duplicate).length, 1, 'exactly one of the two records it');
  assert.equal((await admin.query(`SELECT count(*)::int n FROM payment_provider_refs WHERE object_type='refund' AND external_id='re_race'`))
    .rows[0].n, 1);
  return ['wallet-pack-external-full-review-held', 'wallet-pack-external-replay', 'wallet-pack-settle-admin-only',
    'wallet-pack-settle-clawback-once', 'wallet-pack-external-partial-review', 'wallet-pack-settle-kept',
    'wallet-pack-external-concurrent-once'];
}
