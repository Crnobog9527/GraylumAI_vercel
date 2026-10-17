/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSignupAttribution, signupSourceReport } from './signupAttribution';

const db = (data: unknown, error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
};
const seen = new Date(Date.now() - 3600_000).toISOString();

describe('recordSignupAttribution', () => {
  it('sends only the cleaned record to the database', async () => {
    const d = db(true);
    expect(await recordSignupAttribution(d.client, 'user', { utm_source: 'youtube', utm_campaign: 'Alice.Smith',
      email: 'a@b.c', first_seen_at: seen })).toBe(true);
    expect(d.rpc).toHaveBeenCalledWith('analytics_record_signup_attribution', { p_user: 'user',
      p_attribution: { utm_source: 'youtube', first_seen_at: seen } });
  });
  it('sends nothing for an unusable record and never throws', async () => {
    const d = db(true);
    expect(await recordSignupAttribution(d.client, 'user', { utm_source: 'youtube' })).toBe(false);
    expect(d.rpc).not.toHaveBeenCalled();
    expect(await recordSignupAttribution(db(null, { message: 'down' }).client, 'user', { first_seen_at: seen })).toBe(false);
  });
});

describe('signupSourceReport', () => {
  it('returns the aggregate rows or fails loudly for the admin page', async () => {
    const rows = [{ source: 'youtube', signups: 3, paid: 1 }];
    expect(await signupSourceReport(db(rows).client, 30)).toEqual(rows);
    await expect(signupSourceReport(db(null, { message: 'x' }).client, 30)).rejects.toThrow('ANALYTICS_REPORT_UNAVAILABLE');
  });
});
