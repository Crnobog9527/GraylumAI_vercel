/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real protected PostgreSQL RPCs plus synthetic Stripe responses; not sandbox acceptance.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDurableStripeCheckout } from './stripeCheckoutPersistence';

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

function fixture(kind: 'credit_package' | 'membership_plan' = 'credit_package', cycle = 'monthly') {
  const userId = randomUUID(); let itemId: string = randomUUID();
  const merchant = 'acct_' + randomUUID().replaceAll('-', '');
  const priceId = 'price_' + itemId.replaceAll('-', '');
  sql(`INSERT INTO profiles(id,membership_level) VALUES(${quote(userId)},'free');
    INSERT INTO system_settings(key,value) SELECT 'payment_new_purchase_channel',jsonb_build_object('channel','stripe',
      'version',coalesce((SELECT (value->>'version')::integer FROM system_settings WHERE key='payment_new_purchase_channel'),0)+1)
    ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('channel','stripe',
      'version',(system_settings.value->>'version')::integer+1);`);
  if (kind === 'credit_package') {
    sql(`INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits,active)
      VALUES(${quote(itemId)},'Requote fixture',100,100,20,'true');`);
  } else {
    itemId = sql(`INSERT INTO membership_plans(id,name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
      package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes,is_active)
      VALUES(${quote(itemId)},'Requote membership','pro',100,100,100,100,90,false,false,0,'true') ON CONFLICT(level) DO UPDATE SET monthly_price=100,yearly_price=100,
      monthly_credits=100,yearly_credits=100,is_active='true' RETURNING id;`);
  }
  const billingCycle = kind === 'credit_package' ? 'one_time' as const : cycle as 'monthly' | 'yearly';
  sql(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    ${kind === 'credit_package' ? 'credit_package_id' : 'membership_plan_id'},billing_cycle,is_current)
    VALUES('stripe',${quote(merchant)},'test','price',${quote(priceId)},${quote(itemId)},${quote(billingCycle)},true);`);
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const idempotency = new Map<string, Stripe.Checkout.Session>();
  const prices = new Map([[priceId, 100]]);
  const intents = new Map<string, Stripe.PaymentIntent>();
  const charges: Stripe.Charge[] = [];
  const create = vi.fn(async (request: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => {
    const key = options.idempotencyKey!;
    if (idempotency.has(key)) return structuredClone(idempotency.get(key)!);
    const item = request.line_items![0];
    const session = { id: 'cs_' + randomUUID().replaceAll('-', ''), object: 'checkout.session', status: 'open', payment_status: 'unpaid',
      client_reference_id: request.client_reference_id, metadata: request.metadata, customer: null,
      currency: 'usd', amount_total: item.price_data?.unit_amount ?? prices.get(item.price!), livemode: false,
      mode: request.mode, payment_intent: null, subscription: null,
      url: 'https://checkout.example.test/requote' } as Stripe.Checkout.Session;
    sessions.set(session.id, session); idempotency.set(key, session);
    return structuredClone(session);
  });
  const expire = vi.fn(async (id: string) => {
    const session = sessions.get(id)!;
    if (session.status !== 'open' || session.payment_status !== 'unpaid') throw new Error('Session no longer open');
    session.status = 'expired'; return structuredClone(session);
  });
  const stripe = { prices: { retrieve: async (id: string) => ({ id, object: 'price', active: true, livemode: false,
    currency: 'usd', unit_amount: prices.get(id), billing_scheme: 'per_unit',
    type: kind === 'credit_package' ? 'one_time' : 'recurring',
    recurring: kind === 'credit_package' ? null : { interval: cycle === 'yearly' ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'unspecified' }) }, checkout: { sessions: { create, expire,
      retrieve: async (id: string) => structuredClone(sessions.get(id)),
      list: async () => ({ data: [...sessions.values()].map(session => structuredClone(session)), has_more: false }),
    } }, paymentIntents: { retrieve: async (id: string) => structuredClone(intents.get(id)) },
    charges: { list: async () => ({ object: 'list', has_more: false, data: structuredClone(charges) }) },
  } as unknown as Stripe;
  const args = { db, stripe, scope: { merchant, mode: 'test' as const }, userId, expectedLevel: 'free',
    action: { itemType: kind, itemId, billingCycle }, appUrl: 'https://example.test' };
  const tier = (discount = 90, level = 'gold') => {
    sql(`UPDATE membership_plans SET is_active='false' WHERE level=${quote(level)};
      INSERT INTO membership_plans(name,level,package_discount,allow_fusion_review,allow_fusion_compare,library_storage_bytes,is_active)
      VALUES('Discount fixture',${quote(level)},${discount},false,false,0,'true')
      ON CONFLICT(level) DO UPDATE SET package_discount=${discount},is_active='true';
      UPDATE profiles SET membership_level=${quote(level)} WHERE id=${quote(userId)};`);
    args.expectedLevel = level;
  };
  const orders = () => JSON.parse(sql(`SELECT jsonb_agg(t) FROM
    (SELECT * FROM payment_orders WHERE user_id=${quote(userId)} ORDER BY created_at) t;`)) as Array<Record<string, unknown>>;
  return { args, sessions, create, expire, tier, prices, priceId, intents, charges, orders, itemId, merchant };
}

describe('checkout repricing with real protected PostgreSQL and simulated test-mode Stripe', () => {
  it('free checkout → Gold → new 90-cent checkout, then unchanged quote reuses it', async () => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    expect(first.amount_total).toBe(100);
    const original = t.orders()[0]; t.tier();
    const next = await createDurableStripeCheckout(t.args);
    expect(next.id).not.toBe(first.id); expect(next.amount_total).toBe(90);
    expect(t.sessions.get(first.id)?.status).toBe('expired');
    const replay = await createDurableStripeCheckout(t.args);
    expect(replay.id).toBe(next.id); expect(t.sessions.size).toBe(2);
    expect(t.orders()[0].purchase_snapshot).toEqual(original.purchase_snapshot);
    expect(t.orders()[0].purchase_payload_hash).toBe(original.purchase_payload_hash);
    expect(t.orders()[0].purchase_close_reason).toBe('stripe_checkout_expired');
  });
  it('unchanged pricing reuses the original checkout without any expiration', async () => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    expect((await createDurableStripeCheckout(t.args)).id).toBe(first.id);
    expect(t.create).toHaveBeenCalledOnce(); expect(t.expire).not.toHaveBeenCalled();
  });
  it.each(['tier-same-price', 'discount', 'catalog', 'mapping', 'legacy'] as const)('requotes changed basis: %s', async change => {
    const t = fixture();
    if (change === 'tier-same-price' || change === 'discount') t.tier(90, 'pro');
    if (change === 'legacy') {
      // Historical RPC creates the old action-only digest. Restore the new RPC immediately after admission.
      const { readFileSync } = await import('node:fs');
      const old = readFileSync(resolve(root, 'packages/db/migrations/0173_pay_common_channel.sql'), 'utf8');
      sql(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION public.pay_common_create_purchase'), old.lastIndexOf('COMMIT;')));
      await db.rpc('pay_common_create_purchase', { p_user_id: t.args.userId, p_item_type: 'credit_package', p_item_id: t.itemId,
        p_billing_cycle: 'one_time', p_merchant_namespace: t.merchant, p_payment_mode: 'test', p_expected_level: 'free' });
      sql(readFileSync(resolve(root, 'packages/db/migrations/0177_pay_common_requote.sql'), 'utf8'));
      const oldOrder = t.orders()[0];
      const next = await createDurableStripeCheckout(t.args);
      expect(next.metadata?.orderId).not.toBe(oldOrder.id);
      expect(t.orders()[0].purchase_close_reason).toBe('stripe_checkout_not_prepared'); return;
    }
    const first = await createDurableStripeCheckout(t.args);
    if (change === 'tier-same-price') t.tier(90, 'gold');
    if (change === 'discount') t.tier(80, 'pro');
    if (change === 'catalog') {
      sql(`UPDATE credit_packages SET price=200 WHERE id=${quote(t.itemId)};`);
      t.prices.set(t.priceId, 200);
    }
    if (change === 'mapping') {
      const newPrice = t.priceId + 'new'; t.prices.set(newPrice, 100);
      sql(`UPDATE payment_provider_refs SET is_current=false WHERE external_id=${quote(t.priceId)};
        INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current)
        VALUES('stripe',${quote(t.merchant)},'test','price',${quote(newPrice)},${quote(t.itemId)},'one_time',true);`);
    }
    const next = await createDurableStripeCheckout(t.args);
    expect(next.id).not.toBe(first.id);
    expect(next.amount_total).toBe(change === 'catalog' ? 200 : change === 'discount' ? 80 : change === 'tier-same-price' ? 90 : 100);
    expect((await createDurableStripeCheckout(t.args)).id).toBe(next.id);
  });
  it.each(['monthly', 'yearly'])('membership %s catalog reprices and remains idempotent', async cycle => {
    const t = fixture('membership_plan', cycle); const first = await createDurableStripeCheckout(t.args);
    sql(`UPDATE membership_plans SET monthly_price=200,yearly_price=200 WHERE id=${quote(t.itemId)};`);
    t.prices.set(t.priceId, 200);
    const next = await createDurableStripeCheckout(t.args);
    expect(next.amount_total).toBe(200); expect(next.id).not.toBe(first.id);
    expect((await createDurableStripeCheckout(t.args)).id).toBe(next.id);
  });
  it.each([
    ['credit_package', 'one_time'], ['membership_plan', 'monthly'], ['membership_plan', 'yearly'],
  ] as const)('retires an unpaid disabled %s/%s without a replacement', async (kind, cycle) => {
    const t = fixture(kind, cycle); const first = await createDurableStripeCheckout(t.args);
    sql(`UPDATE ${kind === 'credit_package' ? 'credit_packages' : 'membership_plans'}
      SET ${kind === 'credit_package' ? 'active' : 'is_active'}='false' WHERE id=${quote(t.itemId)};`);
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
    expect(t.sessions.get(first.id)?.status).toBe('expired');
    expect(t.expire).toHaveBeenCalledOnce(); expect(t.create).toHaveBeenCalledOnce();
    expect(t.orders()).toHaveLength(1); expect(t.orders()[0].purchase_closed_at).not.toBeNull();
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
    expect(t.sessions.size).toBe(1);
  });
  it.each(['credit_package', 'membership_plan'] as const)('never expires a paid disabled %s', async kind => {
    const t = fixture(kind); const first = await createDurableStripeCheckout(t.args);
    const session = t.sessions.get(first.id)!; session.status = 'complete'; session.payment_status = 'paid';
    sql(`UPDATE ${kind === 'credit_package' ? 'credit_packages' : 'membership_plans'}
      SET ${kind === 'credit_package' ? 'active' : 'is_active'}='false' WHERE id=${quote(t.itemId)};`);
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
    expect(t.expire).not.toHaveBeenCalled(); expect(t.create).toHaveBeenCalledOnce();
    expect(t.orders()[0].purchase_closed_at).toBeNull();
  });
  it('retires a quote whose current price mapping was removed, without creating a replacement', async () => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args);
    sql(`UPDATE payment_provider_refs SET is_current=false WHERE external_id=${quote(t.priceId)};`);
    await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
    expect(t.sessions.get(first.id)?.status).toBe('expired');
    expect(t.create).toHaveBeenCalledOnce(); expect(t.orders()).toHaveLength(1);
  });
  it.each(['session-paid', 'intent-paid', 'capturable', 'processing', 'successful-charge', 'payment-race'] as const)(
    'never closes or creates a replacement on unsafe evidence: %s', async reason => {
      const t = fixture(); const first = await createDurableStripeCheckout(t.args); t.tier();
      const stored = t.sessions.get(first.id)!;
      if (reason === 'session-paid') { stored.payment_status = 'paid'; stored.status = 'complete'; }
      else if (reason === 'payment-race') t.expire.mockImplementationOnce(async () => {
        stored.payment_status = 'paid'; stored.status = 'complete'; throw new Error('Payment won expiration race');
      });
      else {
        stored.payment_intent = 'pi_fixture';
        t.intents.set('pi_fixture', { id: 'pi_fixture', object: 'payment_intent', metadata: stored.metadata, customer: null,
          amount: 100, currency: 'usd', livemode: false, amount_received: reason === 'intent-paid' ? 100 : 0,
          amount_capturable: reason === 'capturable' ? 100 : 0,
          status: reason === 'processing' ? 'processing' : reason === 'intent-paid' ? 'succeeded' : 'requires_payment_method',
          latest_charge: reason === 'successful-charge' ? 'ch_fixture' : null } as Stripe.PaymentIntent);
        if (reason === 'successful-charge') t.charges.push({ id: 'ch_fixture', object: 'charge', payment_intent: 'pi_fixture',
          customer: null, amount: 100, currency: 'usd', livemode: false, status: 'succeeded', paid: true, amount_captured: 100 } as Stripe.Charge);
      }
      await expect(createDurableStripeCheckout(t.args)).rejects.toThrow();
      expect(t.orders()).toHaveLength(1); expect(t.orders()[0].purchase_closed_at).toBeNull();
      expect(t.sessions.size).toBe(1);
      if (reason !== 'payment-race') expect(t.expire).not.toHaveBeenCalled();
    });
  it('concurrent repricing clicks leave exactly one open order and checkout', async () => {
    const t = fixture(); const first = await createDurableStripeCheckout(t.args); t.tier();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createDurableStripeCheckout(t.args)));
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const open = [...t.sessions.values()].filter(session => session.status === 'open');
    expect(open).toHaveLength(1); expect(open[0].amount_total).toBe(90);
    expect(t.sessions.get(first.id)?.status).toBe('expired');
    expect(t.orders().filter(order => order.purchase_closed_at === null)).toHaveLength(1);
    expect((await createDurableStripeCheckout(t.args)).id).toBe(open[0].id);
  });
});
