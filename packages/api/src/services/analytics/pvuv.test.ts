import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchPvuv, PVUV_TASK_LIMIT_MS, registerPvuvScheduler, snapshotCredits, orderEvent, pvuvEventId, pvuvServerConfig, pvuvVisitorId, reportOrderEvent, sendPvuvEvent, signupEvent } from './pvuv';

const env = { PVUV_SITE: 'site_abc123', PVUV_INGEST_TOKEN: 'token-value-123' };
const ORDER_ID = '00000000-0000-4000-8000-0000000000aa';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';
const order = { id: ORDER_ID, user_id: USER_ID, item_id: 'plan-1', item_type: 'membership_plan', billing_cycle: 'monthly',
  amount_total: 1990, offer_kind: 'founder', payment_channel: 'stripe', payment_method: 'card', method_transition: null,
  purchase_snapshot: snapshot({ credits: 1500, bonus_credits: 300 }) };

function snapshot(credits: { credits: number; bonus_credits: number }) {
  return { version: 1, item_type: 'membership_plan', item_id: '00000000-0000-4000-8000-0000000000cc', item_updated_at: '2026-11-01T00:00:00.000Z',
    billing_cycle: 'monthly', currency: 'usd', unit: 'major', price: '19.90', discount: '0', tax_behavior: 'exclusive', ...credits };
}

/** A minimal Supabase stand-in: every table answers the row given for it. */
function db(rows: Record<string, unknown>) {
  const chain = (table: string) => {
    const result = { data: rows[table] ?? null, error: null };
    const query: Record<string, unknown> = {};
    for (const name of ['select', 'eq']) query[name] = () => query;
    query.maybeSingle = () => Promise.resolve(result);
    return query;
  };
  return { from: (table: string) => chain(table) } as unknown as SupabaseClient;
}
const fakeFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200 });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('pvuv server config and ids', () => {
  it('is off unless both the site and the ingest token are set', () => {
    expect(pvuvServerConfig({})).toBeNull();
    expect(pvuvServerConfig({ PVUV_SITE: 'site_abc123' })).toBeNull();
    expect(pvuvServerConfig(env)).toEqual({ site: 'site_abc123', token: 'token-value-123' });
  });

  it('keeps dedupe ids within pvuv.ai limits (8-64 characters)', () => {
    expect(pvuvEventId('purchase', 'pi_123')).toBe('purchase-pi_123');
    const long = pvuvEventId('purchase', 'x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(pvuvEventId('purchase', 'x'.repeat(200))).toBe(long);
    expect(pvuvEventId('a', 'b').length).toBeGreaterThanOrEqual(8);
  });

  it('reads the visitor id from the _pv_id cookie only, and only a well-formed one', () => {
    expect(pvuvVisitorId(new Headers({ cookie: 'a=1; _pv_id=abc12345-def; b=2' }))).toBe('abc12345-def');
    expect(pvuvVisitorId(new Headers({ cookie: 'a=1' }))).toBeNull();
    expect(pvuvVisitorId(new Headers({ cookie: '_pv_id=short' }))).toBeNull();
    expect(pvuvVisitorId(new Headers({ cookie: '_pv_id=<script>alert(1)</script>' }))).toBeNull();
    expect(pvuvVisitorId(null)).toBeNull();
  });
});

describe('sendPvuvEvent', () => {
  it('posts one event with the bearer token to the site endpoint', async () => {
    const fetch = fakeFetch();
    const ok = await sendPvuvEvent(signupEvent(USER_ID, 'google', 'visitor-12345'), { fetch, env });
    expect(ok).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.pvuv.ai/v1/sites/site_abc123/events');
    expect(init.headers.authorization).toBe('Bearer token-value-123');
    const body = JSON.parse(init.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ name: 'signup', user_id: USER_ID, visitor_id: 'visitor-12345', id: `signup-${USER_ID}`, props: { method: 'google' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends nothing when unconfigured, and never throws on a network error or a refusal', async () => {
    const fetch = fakeFetch();
    expect(await sendPvuvEvent(signupEvent(USER_ID, 'email', null), { fetch, env: {} })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await sendPvuvEvent(signupEvent(USER_ID, 'email', null), { fetch: vi.fn().mockRejectedValue(new Error('boom')), env })).toBe(false);
    expect(await sendPvuvEvent(signupEvent(USER_ID, 'email', null), { fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 }), env })).toBe(false);
  });
});

describe('event content', () => {
  it('signup carries the user id and no visitor id when there is no pvuv cookie (consent refused)', () => {
    const event = signupEvent(USER_ID, 'phone', null);
    expect(event).not.toHaveProperty('visitor_id');
    expect(event.user_id).toBe(USER_ID);
  });

  it('purchase carries revenue in USD, product facts, a payment dedupe id and no personal data', async () => {
    const client = db({ membership_plans: { level: 'gold', monthly_credits: 1500, yearly_credits: 20000 } });
    const event = await orderEvent(client, order, 'purchase', 'pi_3Abc', null);
    expect(event).toEqual({
      name: 'purchase', user_id: USER_ID, id: 'purchase-pi_3Abc', revenue: 19.9, currency: 'USD',
      props: { product: 'membership_plan', interval: 'monthly', channel: 'stripe', method: 'card', discount: 'founder', tier: 'gold', credits: 1800 },
    });
    expect(JSON.stringify(event)).not.toMatch(/@/);
  });

  it('checkout_start and checkout_cancel carry no revenue and use distinct dedupe ids', async () => {
    const client = db({ membership_plans: { level: 'pro', monthly_credits: 1, yearly_credits: 2 } });
    const start = await orderEvent(client, order, 'checkout_start', ORDER_ID, 'visitor-12345');
    const cancel = await orderEvent(client, order, 'checkout_cancel', ORDER_ID, null);
    expect(start).toMatchObject({ name: 'checkout_start', visitor_id: 'visitor-12345', id: `checkout-start-${ORDER_ID}` });
    expect(cancel).toMatchObject({ name: 'checkout_cancel', id: `checkout-cancel-${ORDER_ID}` });
    expect(start).not.toHaveProperty('revenue');
    expect(start!.props).not.toHaveProperty('credits');
  });

  it('credits come from the order\'s frozen purchase snapshot, never from the current catalog', async () => {
    // The catalog row now says something else (changed after the sale); the report must still say what was sold.
    const client = db({ membership_plans: { level: 'gold', monthly_credits: 99999 }, credit_packages: { credits_amount: 99999, bonus_credits: 99999 } });
    const event = await orderEvent(client, order, 'purchase', 'pi_1', null);
    expect(event!.props).toMatchObject({ credits: 1800 });
    expect(snapshotCredits(snapshot({ credits: 1000, bonus_credits: 100 }))).toBe(1100);
    expect(snapshotCredits({ credits: 5 })).toBeUndefined();
    const noSnapshot = await orderEvent(client, { ...order, purchase_snapshot: null }, 'purchase', 'pi_1', null);
    expect(noSnapshot!.props).not.toHaveProperty('credits');
  });

  it('an order without an owner reports nothing', async () => {
    expect(await orderEvent(db({}), { ...order, user_id: null }, 'purchase', 'pi_1', null)).toBeNull();
  });
});

describe('fire-and-forget', () => {
  beforeEach(() => {
    vi.stubEnv('PVUV_SITE', 'site_abc123');
    vi.stubEnv('PVUV_INGEST_TOKEN', 'token-value-123');
    registerPvuvScheduler(null);
  });

  it('hands the work to scheduleAfter and returns before it runs', async () => {
    let scheduled: (() => Promise<unknown>) | null = null;
    const task = vi.fn().mockResolvedValue(undefined);
    expect(dispatchPvuv(task, fn => { scheduled = fn; })).toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    await scheduled!();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('uses the registered scheduler, so payment code need not pass one', async () => {
    let scheduled: (() => Promise<unknown>) | null = null;
    registerPvuvScheduler(fn => { scheduled = fn; });
    const task = vi.fn().mockResolvedValue(undefined);
    dispatchPvuv(task);
    expect(task).not.toHaveBeenCalled();
    await scheduled!();
    expect(task).toHaveBeenCalledTimes(1);
    registerPvuvScheduler(null);
  });

  it('a slow task never delays the caller and is cut off at the limit (database reads included)', async () => {
    vi.useFakeTimers();
    let scheduled: (() => Promise<unknown>) | null = null;
    const slowDb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => undefined) }) }) }) } as unknown as SupabaseClient;
    // The caller gets control back at once even though the order read never answers.
    reportOrderEvent(slowDb, ORDER_ID, 'purchase', 'pi_slow', { scheduleAfter: fn => { scheduled = fn; } });
    expect(scheduled).not.toBeNull();
    const finished = vi.fn();
    const running = scheduled!().then(finished);
    await vi.advanceTimersByTimeAsync(PVUV_TASK_LIMIT_MS - 1);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await running;
    expect(finished).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('swallows a failing task', async () => {
    let scheduled: (() => Promise<unknown>) | null = null;
    dispatchPvuv(() => Promise.reject(new Error('down')), fn => { scheduled = fn; });
    await expect(scheduled!()).resolves.toBeUndefined();
  });

  it('does nothing at all when pvuv is not configured', () => {
    vi.unstubAllEnvs();
    const task = vi.fn();
    dispatchPvuv(task);
    expect(task).not.toHaveBeenCalled();
  });

  it('reportOrderEvent never throws, even when the order cannot be read', async () => {
    let scheduled: (() => Promise<unknown>) | null = null;
    const broken = { from: () => { throw new Error('db down'); } } as unknown as SupabaseClient;
    expect(() => reportOrderEvent(broken, ORDER_ID, 'purchase', 'pi_1', { scheduleAfter: fn => { scheduled = fn; } })).not.toThrow();
    await expect(scheduled!()).resolves.toBeUndefined();
  });

  it('reports a purchase with the order given, sending the dedupe id', async () => {
    const fetch = fakeFetch();
    vi.stubGlobal('fetch', fetch);
    let scheduled: (() => Promise<unknown>) | null = null;
    reportOrderEvent(db({ membership_plans: { level: 'pro' } }), ORDER_ID, 'purchase', 'pi_9', { order, scheduleAfter: fn => { scheduled = fn; } });
    await scheduled!();
    vi.unstubAllGlobals();
    expect(JSON.parse(fetch.mock.calls[0][1].body).events[0].id).toBe('purchase-pi_9');
  });
});
