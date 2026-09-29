import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** A sign-in (password or email code) older than this does not authorize account erasure. */
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;

export const REAUTH_REQUIRED_MESSAGE = 'ACCOUNT_ERASURE_REAUTH_REQUIRED: 请重新验证身份后再确认注销';

function reauthRequired(): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message: REAUTH_REQUIRED_MESSAGE });
}

function bearerToken(headers: Headers | undefined): string | undefined {
  const value = headers?.get('Authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) || undefined : undefined;
}

/**
 * Newest authentication time of the current session. Claims come from getClaims(), which
 * verifies the JWT signature (or asks Auth for legacy keys); an unverified token is never decoded.
 */
export async function readVerifiedAuthTime(input: {
  authClient: SupabaseClient<any, any, any> | null;
  headers?: Headers;
  userId: string;
}): Promise<number | null> {
  if (!input.authClient) {
    return null;
  }
  const { data, error } = await input.authClient.auth.getClaims(bearerToken(input.headers));
  const claims = data?.claims;
  if (error || !claims || claims.sub !== input.userId) {
    return null;
  }
  const times = (claims.amr ?? [])
    .map((entry) => (typeof entry === 'object' && entry ? entry.timestamp : undefined))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return times.length ? Math.max(...times) : null;
}

export function assertRecentAuthTime(authTimeSeconds: number | null, nowMs: number): void {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (authTimeSeconds === null
    || authTimeSeconds > nowSeconds + CLOCK_SKEW_SECONDS
    || nowSeconds - authTimeSeconds > REAUTH_MAX_AGE_SECONDS) {
    throw reauthRequired();
  }
}
