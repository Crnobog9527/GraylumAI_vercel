/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { assertCreditPackageMembership } from './creditPackageMembership';

describe('credit package membership delegates to report authority', () => {
  it('accepts the SQL void result without introducing channel or subscription requirements', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await expect(assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor')).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledExactlyOnceWith('report_membership_check', { p_actor_id: 'server-actor' });
  });
  it.each(['returned', 'thrown'])('maps a %s nonmember refusal to the public permission code', async mode => {
    const error = { message: 'REPORT_MEMBERSHIP_REQUIRED', details: 'PRIVATE_DIAGNOSTIC' };
    const rpc = vi.fn(async () => { if (mode === 'thrown') throw error; return { data: null, error }; });
    await expect(assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PAYWALL_MEMBERSHIP_REQUIRED' });
  });
  it.each([null, undefined, false])('fails closed even when the transport rejects with %s', async cause => {
    const rpc = vi.fn(async () => { throw cause; });
    await expect(assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'PAYWALL_MEMBERSHIP_UNAVAILABLE' });
  });
  it.each(['REPORT_ENTITLEMENTS_UNAVAILABLE', 'PRIVATE_DIAGNOSTIC'])('fails closed on %s', async reason => {
    const rpc = vi.fn(async () => { throw new Error(reason); });
    const error = await assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor').catch(error => error);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'PAYWALL_MEMBERSHIP_UNAVAILABLE' });
    expect(error.cause).toBeUndefined();
  });
});
