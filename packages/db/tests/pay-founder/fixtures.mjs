/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';

/**
 * Founder order fixtures for the throwaway local database only. The checkout, fulfilment, renewal and refund
 * paths are covered by the pay-waffo suites; here only the resulting order facts matter, so the purchase
 * contracts on payment_orders and user_subscriptions are dropped and their guard triggers bypassed. Must run
 * after every catalog comparison of the run.
 */
export async function orderFixtures(c) {
  for (const table of ['payment_orders', 'user_subscriptions']) {
    const checks = (await c.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'", [table])).rows;
    for (const { conname } of checks) await c.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${JSON.stringify(conname)}`);
  }
  const plan = (await c.query("SELECT id FROM membership_plans WHERE level='gold' LIMIT 1")).rows[0]?.id ?? randomUUID();
  const bypass = async work => {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role='replica'");
    try { const result = await work(); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
  };
  const at = ms => (ms == null ? null : new Date(ms));
  return {
    async profile(role = 'user') {
      const id = randomUUID();
      await c.query('INSERT INTO profiles(id,credits,role,email) VALUES($1,0,$2,$3)', [id, role, `${id.slice(0, 8)}@founder.test`]);
      return id;
    },
    /** One fulfilled Gold yearly order; card methods also get their renewing subscription. */
    order(user, { method = 'alipay', offer = 'founder', qualification = 'sold', start, end, paid, refund, failedAt,
      cancelRequested = false } = {}) {
      return bypass(async () => {
        const card = method === 'card' || method === 'card_cn';
        let sub = null;
        if (card) {
          sub = (await c.query(`INSERT INTO user_subscriptions(user_id,membership_plan_id,status,billing_cycle,current_period_start,
            current_period_end,cancel_at_period_end,founder_failed_at,method_cancel_requested_at,payment_channel,payment_mode)
            VALUES($1,$2,'active','yearly',$3,$4,'false',$5,$6,'stripe','test') RETURNING id`,
          [user, plan, at(start), at(end), at(failedAt), cancelRequested ? new Date() : null])).rows[0].id;
        }
        const id = randomUUID();
        await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,
          payment_status,payment_channel,payment_mode,payment_method,auto_renew,entitlement_term,offer_kind,qualification_state,
          qualified_paid_at,fulfilled_at,entitlement_start,entitlement_end,subscription_id,created_at)
          VALUES($1,$2,'membership_plan',$3,'yearly',49600,'usd',$4,$5,$6,'stripe','test',$7,$8,'year',$9,$10,$11,$12,$13,$14,$15,$13)`,
        [id, user, plan, card ? 'subscription' : 'payment', refund ? 'refunded' : 'completed', refund ?? 'paid', method, card,
          offer, qualification, at(paid ?? start), qualification === 'sold' ? at(paid ?? start) : null, at(start), at(end), sub]);
        return id;
      });
    },
    refund(order) {
      return bypass(() => c.query("UPDATE payment_orders SET status='refunded',payment_status='refunded',updated_at=now()"
        + ' WHERE id=$1', [order]));
    },
  };
}
