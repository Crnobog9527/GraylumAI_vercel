/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOUNDER_PRICE_CENTS, FOUNDER_SEATS_TOTAL, GOLD_FIRST_MONTH_CENTS, readPublicOffers, resetPublicOffersCache,
} from './publicOffers';

const migrations = join(__dirname, '../../../../db/migrations');
/** The newest migration that (re)defines the checkout rules: offer prices and the founder cap live there. */
function checkoutRules() {
  const file = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort().reverse()
    .find(name => readFileSync(join(migrations, name), 'utf8').includes('PAY_WAFFO_FOUNDER_SOLD_OUT'));
  return readFileSync(join(migrations, file!), 'utf8');
}

type Filter = [string, ...unknown[]];
function database(count: number | null, error: unknown = null) {
  const filters: Filter[] = [];
  const chain = {
    select: (...args: unknown[]) => { filters.push(['select', ...args]); return chain; },
    eq: (...args: unknown[]) => { filters.push(['eq', ...args]); return chain; },
    or: (...args: unknown[]) => { filters.push(['or', ...args]); return Promise.resolve({ count, error }); },
  };
  const from = vi.fn((table: string) => { filters.push(['from', table]); return chain; });
  return { db: { from } as never, from, filters };
}
const stripeIn = (livemode: boolean) => ({
  accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_test123' })) },
  balance: { retrieve: vi.fn(async () => ({ livemode })) },
}) as never;

beforeEach(() => resetPublicOffersCache());

describe('public offers', () => {
  it('match the checkout function rules (first month 4900, founder 49600, sold out at 50)', () => {
    const sql = checkoutRules();
    expect(sql).toContain(`IF p_offer='gold_first30' THEN cents:=${GOLD_FIRST_MONTH_CENTS}; END IF;`);
    expect(sql).toContain(`cents:=${FOUNDER_PRICE_CENTS};`);
    expect(sql).toContain(`>=${FOUNDER_SEATS_TOTAL} THEN\n        RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_SOLD_OUT'`);
  });

  it('counts held seats exactly like checkout, in the authenticated Stripe mode, and returns only public numbers', async () => {
    const f = database(13);
    const offers = await readPublicOffers(f.db, stripeIn(false));
    expect(offers).toEqual({ goldFirstMonth: 49, founder: { price: 496, total: 50, available: 37 } });
    expect(f.filters).toEqual([
      ['from', 'payment_orders'], ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'payment_mode', 'test'], ['eq', 'offer_kind', 'founder'],
      ['or', 'qualification_state.in.(reserved,sold),and(qualification_state.eq.review,qualification_closed_ref.is.null)'],
    ]);
    resetPublicOffersCache();
    const live = database(60);
    expect(await readPublicOffers(live.db, stripeIn(true))).toEqual({ goldFirstMonth: 49,
      founder: { price: 496, total: 50, available: 0 } });
    expect(live.filters).toContainEqual(['eq', 'payment_mode', 'live']);
  });

  it('hides the founder offer instead of guessing when Stripe, the database or the count is unavailable', async () => {
    expect(await readPublicOffers(null, stripeIn(false))).toEqual({ goldFirstMonth: 49, founder: null });
    expect(await readPublicOffers(database(1).db, null)).toEqual({ goldFirstMonth: 49, founder: null });
    expect(await readPublicOffers(database(null, { code: '57014' }).db, stripeIn(false))).toEqual({ goldFirstMonth: 49, founder: null });
    const broken = { accounts: { retrieveCurrent: async () => { throw new Error('down'); } }, balance: { retrieve: async () => ({}) } };
    expect(await readPublicOffers(database(1).db, broken as never)).toEqual({ goldFirstMonth: 49, founder: null });
  });

  it('caches a full answer for a minute, but never caches a missing founder answer', async () => {
    const failing = database(null, { code: 'x' });
    await readPublicOffers(failing.db, stripeIn(false), 1_000);
    const ok = database(5);
    expect((await readPublicOffers(ok.db, stripeIn(false), 2_000)).founder?.available).toBe(45);
    const later = database(49);
    expect((await readPublicOffers(later.db, stripeIn(false), 61_000)).founder?.available).toBe(45);
    expect(later.from).not.toHaveBeenCalled();
    expect((await readPublicOffers(later.db, stripeIn(false), 62_001)).founder?.available).toBe(1);
  });
});
