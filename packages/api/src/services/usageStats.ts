/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/*
 * One account's usage counts and credit totals, summed in the database (migration 0513_profile_usage_stats).
 *  - The counts come from the per-turn core (`turns`, `session_messages`): the tables the retired chat path wrote
 *    (`conversations`, `messages`) get no new rows, and the core tables are not readable by any API role.
 *  - The totals are not summed in Node any more: an unpaged `credit_transactions` read is cut at PostgREST's row cap, so an
 *    account with more ledger rows in the period got a total that was silently too small.
 * Both functions are service_role only; the caller passes an id it has already verified (the signed-in account's own, or
 * the account an admin page shows).
 */
type Rpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };

const count = z.number().int().nonnegative();
const usageStats = z.object({ conversations: count, messages: count, usageDays: count });
const bucket = z.object({ count, amount: z.number().int() });
const creditSummary = z.object({
  totalEarned: count,
  totalSpent: count,
  transactionCount: count,
  byType: z.record(z.string(), bucket),
  byLedgerType: z.record(z.string(), bucket),
});

export type UsageStats = z.infer<typeof usageStats>;
export type CreditSummary = z.infer<typeof creditSummary>;

/** A failed or malformed read, with the database code when there is one; never a zero that looks like a real number. */
export class UsageStatsReadError extends Error {
  constructor(readonly code: string | null) {
    super('USAGE_STATS_UNAVAILABLE');
  }
}

async function read<T>(db: Rpc, name: string, args: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) throw new UsageStatsReadError(result.error.code ?? null);
  const parsed = shape.safeParse(result.data);
  if (!parsed.success) throw new UsageStatsReadError(null);
  return parsed.data;
}

/** Conversations, messages and days of use on the per-turn core (a scheduled review is not a conversation the user started). */
export const readUsageStats = (db: Rpc, userId: string) =>
  read(db, 'usage_stats_for_user', { p_user_id: userId }, usageStats);

/** Ledger totals from `from` on (null: all time). `totalSpent` is credits actually charged: reservations and releases are not spend. */
export const readCreditSummary = (db: Rpc, userId: string, from: Date | null) =>
  read(db, 'usage_credit_summary_for_user', { p_user_id: userId, p_from: from ? from.toISOString() : null }, creditSummary);

/**
 * "本月" everywhere on the profile is the calendar month in UTC (Owner 2026-10-25: users see credits actually charged; the
 * same month on every card). It used to be the calendar month on one card and the last 30 days on another.
 */
export const utcMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
