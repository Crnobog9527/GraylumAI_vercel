/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Reuse report admission's paid-membership authority, including one-time grants
 * and known expiry. The client and actor must come from authenticated server context. */
export async function assertCreditPackageMembership(db: Pick<SupabaseClient, 'rpc'>, actorId: string) {
  let error: unknown;
  try {
    const result = await db.rpc('report_membership_check', { p_actor_id: actorId });
    if (!result.error) return;
    error = result.error;
  } catch (cause) {
    error = cause;
  }
  const denied = error !== null && typeof error === 'object' && 'message' in error
    && error.message === 'REPORT_MEMBERSHIP_REQUIRED';
  throw new TRPCError({ code: denied ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE',
    message: denied ? 'PAYWALL_MEMBERSHIP_REQUIRED' : 'PAYWALL_MEMBERSHIP_UNAVAILABLE' });
}
