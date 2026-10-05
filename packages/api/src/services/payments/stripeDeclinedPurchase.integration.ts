/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real protected PostgreSQL RPCs plus synthetic Stripe responses; not sandbox acceptance.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDurableStripeCheckout, recordStripeCheckout } from './stripeCheckoutPersistence';

const root = resolve(import.meta.dirname, '../../../../..');
let local: { endpoint: string; name: string; steps: number };
const options = { encoding: 'utf8' as const, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  maxBuffer: 32 * 1024 * 1024 };
function sql(text: string) {
  return execFileSync('docker', ['--host', local.endpoint, 'exec', '-i', local.name, 'psql', '-X', '-qAt',
    '-U', 'postgres', '-d', 'paycommon', '-v', 'ON_ERROR_STOP=1', '-c', text], options).trim();
}
const quote = (value: unknown) => value === null ? 'NULL' : `'${String(typeof value === 'object'
  ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
const identifier = (value: string) => {
  if (!/^[a-z_]+$/.test(value)) throw new Error('Invalid fixture identifier');
  return value;
};
const db = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    try {
      const data = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT to_jsonb(public.${identifier(name)}(`
        + Object.entries(args).map(([key, value]) => `${identifier(key)} => ${quote(value)}`).join(',') + ')); COMMIT;');
      return { data: JSON.parse(data), error: null };
    } catch (error) { return { data: null, error }; }
  },
  from: (table: string) => {
    const filters: string[] = [];
    const read = () => JSON.parse(sql('BEGIN; SET LOCAL ROLE service_role; SELECT coalesce(jsonb_agg(t),\'[]\') FROM '
      + `(SELECT * FROM ${identifier(table)} WHERE ${filters.join(' AND ')}) t; COMMIT;`));
    const query = { select: () => query, eq: (key: string, value: unknown) => {
      filters.push(`${identifier(key)}=${quote(value)}`); return query;
    }, limit: async () => ({ data: read(), error: null }),
    maybeSingle: async () => ({ data: read()[0] ?? null, error: null }) };
    return query;
  },
} as unknown as Pick<SupabaseClient, 'from' | 'rpc'>;

beforeAll(() => {
  local = JSON.parse(execFileSync('node', [resolve(root, 'packages/db/tests/pay-common/decline-local-db.mjs'),
    '--local-only'], { ...options, timeout: 240000 }));
  expect(local.steps).toBeGreaterThan(170);
}, 240000);
afterAll(() => {
  if (local) execFileSync('docker', ['--host', local.endpoint, 'rm', '-f', '-v', local.name], options);
});

function fixture() {
  const userId = randomUUID(), itemId = randomUUID(), otherId = randomUUID();
  // Only fixture seeding uses postgres. All business operations above execute as service_role.
  sql(`INSERT INTO profiles(id,membership_level) VALUES(${quote(userId)},'free');
    INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,active) VALUES
    (${quote(itemId)},'Decline fixture',100,100,20,'true'),(${quote(otherId)},'Replacement fixture',100,200,30,'true');
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
    VALUES('stripe','acct_fixture','test','price',${quote('price_' + itemId.replaceAll('-', ''))},${quote(itemId)},'one_time',true),
    ('stripe','acct_fixture','test','price',${quote('price_' + otherId.replaceAll('-', ''))},${quote(otherId)},'one_time',true);`);
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const intents = new Map<string, Stripe.PaymentIntent>();
  const create = vi.fn(async (request: Stripe.Checkout.SessionCreateParams) => {
    const session = { id: 'cs_' + randomUUID().replaceAll('-', ''), object: 'checkout.session', status: 'open', payment_status: 'unpaid',
      client_reference_id: request.client_reference_id, metadata: request.metadata, customer: null,
      currency: 'usd', amount_total: 100, livemode: false, mode: request.mode, payment_intent: null, subscription: null,
      url: 'https://checkout.example.test/fixture' } as Stripe.Checkout.Session;
    sessions.set(session.id, session); return structuredClone(session);
  });
  const stripe = { prices: { retrieve: async (id: string) => ({ id, object: 'price', active: true, livemode: false,
    currency: 'usd', unit_amount: 100, billing_scheme: 'per_unit', type: 'one_time', recurring: null, tax_behavior: 'unspecified' }) },
    checkout: { sessions: { create,
      retrieve: async (id: string) => structuredClone(sessions.get(id)),
      expire: async (id: string) => { const session = sessions.get(id)!; session.status = 'expired'; return session; } } },
    paymentIntents: { retrieve: async (id: string) => structuredClone(intents.get(id)) },
    charges: { list: async ({ payment_intent }: { payment_intent: string }) => ({ object: 'list', has_more: false,
      data: [{ id: 'ch_' + payment_intent, object: 'charge', payment_intent, customer: null,
        status: 'failed', paid: false, amount_captured: 0, amount: 100, currency: 'usd', livemode: false }] }) },
  } as unknown as Stripe;
  const args = { db, stripe, scope: { merchant: 'acct_fixture', mode: 'test' as const }, userId, expectedLevel: 'free',
    action: { itemType: 'credit_package' as const, itemId, billingCycle: 'one_time' as const }, appUrl: 'https://example.test' };
  const decline = (sessionId: string, status: string) => {
    const session = sessions.get(sessionId)!;
    const id = 'pi_' + randomUUID().replaceAll('-', ''); session.payment_intent = id;
    intents.set(id, { id, object: 'payment_intent', status, amount: 100, amount_received: 0, amount_capturable: 0,
      currency: 'usd', livemode: false, customer: null, metadata: session.metadata, latest_charge: 'ch_' + id } as Stripe.PaymentIntent);
    return session;
  };
  const orders = () => JSON.parse(sql(`SELECT coalesce(jsonb_agg(t),'[]') FROM
    (SELECT id,item_id,status,payment_status,purchase_close_reason,fulfilled_at FROM payment_orders
    WHERE user_id=${quote(userId)} ORDER BY created_at) t;`)) as Array<Record<string, unknown>>;
  return { args, create, decline, orders, otherId, sessions, intents };
}

describe('decline recovery through real protected purchase RPCs', () => {
  it.each(['canceled', 'requires_payment_method'])('decline → choose another item with %s', async status => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    const old = t.decline(first.id, status);
    t.args.action.itemId = t.otherId;
    const replacement = await createDurableStripeCheckout(t.args);
    expect(old.status).toBe('expired');
    expect(replacement.id).not.toBe(first.id);
    expect(t.orders()).toEqual([
      expect.objectContaining({ status: 'expired', payment_status: 'unpaid', purchase_close_reason: 'stripe_checkout_expired', fulfilled_at: null }),
      expect.objectContaining({ item_id: t.otherId, status: 'pending', payment_status: 'unpaid', purchase_close_reason: null }),
    ]);
    const replay = await createDurableStripeCheckout(t.args);
    expect(replay.id).toBe(replacement.id);
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(sql(`SELECT count(*) FROM credit_transactions WHERE user_id=${quote(t.args.userId)}`)).toBe('0');
  });
  it.each(['canceled', 'requires_payment_method'])('decline → buy the same item with %s only replaces after expiry', async status => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    const old = t.decline(first.id, status);
    expect((await createDurableStripeCheckout(t.args)).id).toBe(first.id);
    expect(t.orders()).toHaveLength(1);
    old.status = 'expired';
    const replacement = await createDurableStripeCheckout(t.args);
    expect(replacement.id).not.toBe(first.id);
    expect(t.orders()).toHaveLength(2);
    expect(t.orders()[0].purchase_close_reason).toBe('stripe_checkout_expired');
    expect((await createDurableStripeCheckout(t.args)).id).toBe(replacement.id);
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(sql(`SELECT count(*) FROM credit_transactions WHERE user_id=${quote(t.args.userId)}`)).toBe('0');
  });
  it.each(['processing', 'succeeded'])('keeps %s payment evidence unresolved and creates no replacement', async status => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    const old = t.decline(first.id, status); old.status = 'expired';
    t.args.action.itemId = t.otherId;
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
    expect(t.orders()).toHaveLength(1);
    expect(t.orders()[0]).toMatchObject({ purchase_close_reason: null, fulfilled_at: null });
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  it('the protected close RPC rejects a paid fact arriving after the unpaid provider read', async () => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    const old = t.decline(first.id, 'canceled'); old.status = 'expired';
    t.args.action.itemId = t.otherId;
    const raceDb = { from: db.from, rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'pay_common_close_checkout') {
        await recordStripeCheckout(db, old.metadata!.orderId, t.args.scope,
          { ...old, status: 'complete', payment_status: 'paid' });
      }
      return db.rpc(name, args);
    } } as unknown as Pick<SupabaseClient, 'from' | 'rpc'>;
    await expect(createDurableStripeCheckout({ ...t.args, db: raceDb })).rejects.toThrow('PAY_COMMON_ATTEMPT_CLOSE_FAILED');
    expect(t.orders()).toHaveLength(1);
    expect(t.orders()[0]).toMatchObject({ payment_status: 'paid', purchase_close_reason: null });
    expect(t.create).toHaveBeenCalledTimes(1);
  });
});
