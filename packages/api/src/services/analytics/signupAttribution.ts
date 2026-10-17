/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { parseSignupAttribution } from '../../shared/analyticsAttribution';

/**
 * First source of a new account (ANALYTICS plan §3.2, migration 0281). The browser sends it once, only with
 * statistics consent; the server keeps registered UTM values, a referrer host name and a route template only,
 * and the database writes it only while empty, for an account created in the last 30 days. Statistics only:
 * a refusal or failure is logged and never reaches the user.
 */
export async function recordSignupAttribution(db: SupabaseClient, userId: string, raw: unknown): Promise<boolean> {
  const attribution = parseSignupAttribution(raw);
  if (!attribution) return false;
  try {
    const result = await db.rpc('analytics_record_signup_attribution', { p_user: userId, p_attribution: attribution });
    if (result.error) throw result.error;
    return result.data === true;
  } catch (error) {
    logger.warn('system', 'analytics_signup_attribution_failed', { reason: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
}

export type SignupSourceRow = { source: string; signups: number; paid: number };

/** Sign-ups and paying accounts per first source (aggregates only) for the admin statistics page. */
export async function signupSourceReport(db: SupabaseClient, days: number): Promise<SignupSourceRow[]> {
  const result = await db.rpc('analytics_signup_source_report', { p_days: days });
  if (result.error || !Array.isArray(result.data)) throw new Error('ANALYTICS_REPORT_UNAVAILABLE', { cause: result.error });
  return result.data as SignupSourceRow[];
}
