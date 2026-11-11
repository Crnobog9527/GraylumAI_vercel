/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The readiness audit's check for billing reservations (pre_deduct records in billing_history) that have no observed terminal
// record (settle, refund, abort_settle). Split out of billingReconciliation.ts. It only reports: nothing here releases funds.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingReadinessFinding } from './billingReconciliation';
import type { BillingHistoryRow } from './billingReadinessRows';

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const toInteger = (value: number | string | null | undefined) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};
const getCreatedAtMs = (row: { created_at?: string | null }) => {
  const parsed = typeof row.created_at === 'string' && row.created_at.trim() ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const RESERVATION_CLOSING_OPERATIONS = new Set<string>(['settle', 'refund', 'abort_settle']);
/** A reservation younger than this may simply be in flight (a turn in progress, a paused round waiting for its 24 h refund):
 * it is reported as a warning. The oldest one being older than this makes the finding an error. */
const RESERVATION_ERROR_AGE_HOURS = 48;
const RESERVATION_HOLD_IDS_SHOWN = 50;
const FUTURE_TOLERANCE_MS = 3_600_000;

/**
 * PUBLISH-SCHEDULE: the holds of scheduled publishes (hold id -> scheduled time in ms). A scheduled publish holds its
 * credits from confirmation until Post for Me sends it (up to 30 days), so its hold is "in flight" until the scheduled
 * time and ages from then. Any failure to read returns no entries: every hold then ages from its creation (more findings,
 * never fewer).
 */
export async function readScheduledHolds(supabase: Pick<SupabaseClient, 'rpc'>): Promise<Map<string, number>> {
  const holds = new Map<string, number>();
  try {
    const { data, error } = await supabase.rpc('publish_monitor_schedule_holds');
    if (error || !Array.isArray(data)) return holds;
    for (const entry of data as Array<Record<string, unknown>>) {
      const at = typeof entry?.scheduledAt === 'string' ? Date.parse(entry.scheduledAt) : NaN;
      if (typeof entry?.preDeductId === 'string' && Number.isFinite(at)) holds.set(entry.preDeductId, at);
    }
  } catch { holds.clear(); }
  return holds;
}

function summarizeReservations(holds: BillingHistoryRow[], nowMs: number, scheduled: Map<string, number>) {
  const accounts = new Set<string>();
  let credits = 0;
  // A hold without a readable creation time cannot be shown young: it counts as the oldest.
  let oldestMs: number | null = null;
  let timeUnknown = false;
  for (const hold of holds) {
    accounts.add(hold.user_id as string);
    credits += Math.abs(toInteger(hold.amount));
    const createdAt = getCreatedAtMs(hold);
    const scheduledAt = hold.id ? scheduled.get(hold.id) : undefined;
    // A scheduled publish's hold is in flight until its time and ages from then (a time still ahead counts as now).
    const createdMs = createdAt === null || scheduledAt === undefined ? createdAt
      : Math.max(createdAt, Math.min(scheduledAt, nowMs));
    // An unreadable creation time, or one more than an hour in the future (a skewed clock), cannot show the hold young.
    if (createdMs === null || createdMs > nowMs + FUTURE_TOLERANCE_MS) timeUnknown = true;
    else if (oldestMs === null || createdMs < oldestMs) oldestMs = createdMs;
  }
  const oldestAgeHours = oldestMs === null ? 0 : Math.max(0, Math.floor((nowMs - oldestMs) / 3_600_000));
  const olderThanLimit = oldestMs !== null && nowMs - oldestMs > RESERVATION_ERROR_AGE_HOURS * 3_600_000;
  return { count: holds.length, accounts: accounts.size, credits, oldestAgeHours, oldestMs, timeUnknown, olderThanLimit };
}

/** Reservations without an observed terminal record, summarised in one finding per scope instead of one per hold: those
 * created before the launch baseline are historical (like the other findings), the others are a warning unless the oldest is
 * older than RESERVATION_ERROR_AGE_HOURS (or has no readable time), then an error. Nothing here releases funds. */
export function reservationFindings(
  holds: BillingHistoryRow[],
  now: Date,
  launchBaselineAt: Date | undefined,
  scheduledHolds: Map<string, number> = new Map(),
): BillingReadinessFinding[] {
  if (holds.length === 0) return [];
  const baselineMs = launchBaselineAt?.getTime() ?? null;
  const before = baselineMs === null ? [] : holds.filter((hold) => {
    const createdMs = getCreatedAtMs(hold);
    return createdMs !== null && createdMs < baselineMs;
  });
  const beforeSet = new Set(before);
  const groups: Array<{ holds: BillingHistoryRow[]; preBaseline: boolean }> = [
    { holds: before, preBaseline: true },
    { holds: holds.filter((hold) => !beforeSet.has(hold)), preBaseline: false },
  ];
  return groups.filter((group) => group.holds.length > 0).map(({ holds: group, preBaseline }) => {
    const summary = summarizeReservations(group, now.getTime(), scheduledHolds);
    const old = summary.timeUnknown || summary.olderThanLimit;
    return {
      code: 'billing_reservation_unresolved',
      severity: preBaseline || old ? 'error' : 'warning',
      message: 'Billing reservations have no observed terminal record; preserve funds and verify outcome '
        + `(count=${summary.count}, oldestAgeHours=${summary.oldestAgeHours}, accounts=${summary.accounts}, credits=${summary.credits})`,
      entityType: 'billing_history',
      metadata: {
        count: summary.count, accounts: summary.accounts, credits: summary.credits, oldestAgeHours: summary.oldestAgeHours,
        oldestCreatedAt: summary.oldestMs === null ? null : new Date(summary.oldestMs).toISOString(),
        holdIds: group.slice(0, RESERVATION_HOLD_IDS_SHOWN).map((hold) => hold.id),
        holdIdsTruncated: group.length > RESERVATION_HOLD_IDS_SHOWN,
        preBaseline,
        providerOutcome: 'unproven', automaticRefundAllowed: false,
      },
    } satisfies BillingReadinessFinding;
  });
}

export function enforcedReservationSummary(enforced: BillingReadinessFinding[]) {
  const found = enforced.find((finding) => finding.code === 'billing_reservation_unresolved');
  const meta = found?.metadata ?? {};
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { count: num(meta.count), oldestAgeHours: num(meta.oldestAgeHours), accounts: num(meta.accounts), credits: num(meta.credits) };
}


/** The reservations (pre_deduct) with no closing record of the same user that names them. One pass over the history: the scan
 * used to be quadratic (every hold searched the whole history). */
export function findUnresolvedReservations(history: BillingHistoryRow[]): BillingHistoryRow[] {
  const closed = new Set<string>();
  for (const entry of history) {
    if (!entry.user_id || !RESERVATION_CLOSING_OPERATIONS.has(entry.operation_type ?? '')) continue;
    const preDeductId = asRecord(entry.metadata).preDeductId;
    if (typeof preDeductId === 'string') closed.add(`${entry.user_id}\u0000${preDeductId}`);
  }
  return history.filter((hold) => hold.operation_type === 'pre_deduct' && hold.id && hold.user_id
    && !closed.has(`${hold.user_id}\u0000${hold.id}`));
}
