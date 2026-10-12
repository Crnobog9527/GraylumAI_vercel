/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { assertCreditPackageMembership } from './creditPackageMembership';

describe('credit package membership delegates to report authority', () => {
  it('accepts the SQL void result without introducing channel or subscription requirements', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await expect(assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor')).resolves.toBeUndefined();
    expect(rpc).toHaveBeenNthCalledWith(1, 'report_membership_check', { p_actor_id: 'server-actor' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'pay_common_membership_facts', { p_user_id: 'server-actor' });
  });
  it('refuses packages during the 0214 renewal grace even though member access is kept', async () => {
    const rpc = vi.fn(async (fn: string) => (fn === 'report_membership_check' ? { data: null, error: null }
      : { data: { internal_membership: { mapping_state: 'internal_paid', renewal_grace_until: '2026-11-11T16:49:49Z' } }, error: null }));
    await expect(assertCreditPackageMembership({ rpc } as unknown as SupabaseClient, 'server-actor'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PAYWALL_MEMBERSHIP_REQUIRED' });
    const unavailable = vi.fn(async (fn: string) => (fn === 'report_membership_check' ? { data: null, error: null }
      : { data: null, error: { message: 'boom' } }));
    await expect(assertCreditPackageMembership({ rpc: unavailable } as unknown as SupabaseClient, 'server-actor'))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
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
