/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { purchaseSnapshotSchema } from './contracts';

export const ANNUAL_RELEASE_REVIEW_REQUIRED = 'PAY_COMMON_ANNUAL_RELEASE_REVIEW_REQUIRED';
type Subscription = { id?: string | null; membership_plan_id?: string | null; current_period_start?: string | null;
  payment_channel?: string | null; merchant_namespace?: string | null; payment_mode?: string | null };
type OpeningGrant = { subscription_id?: string | null; source_order_id?: string | null; period_index?: number | null;
  period_start?: string | null; status?: string | null; grant_snapshot?: unknown };

function report(subscription: Subscription, reason: string) {
  logger.error('billing', 'annual_subscription_credit_release_skipped', {
    code: ANNUAL_RELEASE_REVIEW_REQUIRED, reason,
    subscriptionId: subscription.id ? `${subscription.id.slice(0, 8)}...${subscription.id.slice(-6)}` : null,
  });
}

export function resolveAnnualReleaseContract<T extends OpeningGrant>(subscription: Subscription, grants: T[]) {
  const start = Date.parse(subscription.current_period_start ?? '');
  const opening = grants.filter(grant => grant.subscription_id === subscription.id && grant.period_index === 1
    && Number.isFinite(start) && Date.parse(grant.period_start ?? '') === start && grant.status === 'granted' && grant.source_order_id);
  if (opening.length !== 1) {
    report(subscription, 'PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN');
    return null;
  }
  const snapshot = purchaseSnapshotSchema.safeParse(opening[0]!.grant_snapshot);
  if (!snapshot.success || snapshot.data.item_id !== subscription.membership_plan_id
    || snapshot.data.billing_cycle !== 'yearly' || snapshot.data.item_type !== 'membership_plan') {
    report(subscription, 'PAY_COMMON_GRANT_SNAPSHOT_MISMATCH');
    return null;
  }
  return { openingGrant: opening[0]!, plan: { id: snapshot.data.item_id, yearly_credits: snapshot.data.credits, name: 'Membership' } };
}

export async function resolveAnnualSubscriptionRefs<T extends Subscription>(db: Pick<SupabaseClient, 'from'>, rows: T[]) {
  return await Promise.all(rows.map(async row => {
    if (row.payment_channel !== 'stripe') return { ...row, stripe_subscription_id: null };
    const refs = await db.from('payment_provider_refs').select('external_id').eq('subscription_id', row.id)
      .eq('object_type', 'subscription').eq('channel', 'stripe').eq('merchant_namespace', row.merchant_namespace)
      .eq('mode', row.payment_mode).limit(2);
    // An unavailable database is not a malformed individual subscription. Keep the run failed/retryable.
    if (refs.error || !Array.isArray(refs.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: refs.error });
    if (refs.data.length !== 1 || typeof refs.data[0]?.external_id !== 'string' || !refs.data[0].external_id) {
      report(row, 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING');
      return { ...row, stripe_subscription_id: null };
    }
    return { ...row, stripe_subscription_id: refs.data[0].external_id as string };
  }));
}
