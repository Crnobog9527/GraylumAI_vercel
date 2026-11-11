/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { readAllReportRows } from './reportRows';

/*
 * The admin home, finance and performance pages on the per-turn core (migration `admin_stats_new_path`).
 * They used to count rows of `conversations`, `messages`, `token_stats` and `ai_usage_logs`, which only the retired chat path
 * wrote, and to sum whole tables in Node from unpaged reads. The core tables are not readable by any API role, so three
 * service_role-only database functions aggregate them; this module calls the functions and checks what comes back.
 * A failed or malformed read is an error for the caller to report, never a zero.
 */
type Page = PromiseLike<{ data: unknown; error: { code?: string } | null }>;
type RpcBuilder = Page & { order(column: string, options?: Record<string, unknown>): RpcBuilder; range(from: number, to: number): Page };
type Db = { rpc(name: string, args: Record<string, unknown>): unknown };

export class AdminActivityReadError extends Error {
  constructor(readonly source: string, readonly code: string | null) {
    super('ADMIN_ACTIVITY_UNAVAILABLE');
  }
}

const count = z.number().int().nonnegative();
const tokens = count.nullable();
const usageDay = z.object({
  model_used: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  requests: count,
  total_credits: count,
  total_cost_usd: z.string().regex(/^\d+(\.\d+)?$/),
  input_tokens: tokens, output_tokens: tokens, cached_tokens: tokens, cache_creation_tokens: tokens,
});
export type UsageDay = z.infer<typeof usageDay>;

/**
 * Spent model calls grouped by model and UTC day, from `from` (null: all time) to `to`. Days before `dailyFrom` come folded
 * into one row per model (`day` null), so an all-time read stays a few rows.
 */
export async function readUsageDays(db: Db, from: Date | null, to: Date, dailyFrom: Date): Promise<UsageDay[]> {
  const args = { p_from: from ? from.toISOString() : null, p_to: to.toISOString(), p_daily_from: dailyFrom.toISOString() };
  const result = await readAllReportRows((first, last) => (db.rpc('turn_admin_usage_days', args) as RpcBuilder)
    .order('model_used').order('day', { nullsFirst: true }).range(first, last) as PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>);
  if (result.error || !Array.isArray(result.data)) throw new AdminActivityReadError('usage days', result.error?.code ?? null);
  const parsed = z.array(usageDay).safeParse(result.data);
  if (!parsed.success) throw new AdminActivityReadError('usage days', null);
  return parsed.data;
}

/** The time a folded row (no day) is given: before every chart window, so it only counts in all-time sums. */
const FOLDED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Usage days in the shape the report helpers already take for token_stats rows, one row per model and day carrying how many
 * requests it stands for. A row of the retired path is one request (`requests` absent).
 */
export const usageDaysAsTokenRows = (days: UsageDay[]) => days.map((day) => ({
  model_used: day.model_used,
  total_credits: day.total_credits,
  total_cost_usd: day.total_cost_usd,
  input_tokens: day.input_tokens,
  output_tokens: day.output_tokens,
  cached_tokens: day.cached_tokens,
  cache_creation_tokens: day.cache_creation_tokens,
  created_at: day.day ? `${day.day}T00:00:00.000Z` : FOLDED_AT,
  requests: day.requests,
}));

/** How many requests a list of token rows stands for. */
export const requestCount = (rows: Array<{ requests?: number }>) => rows.reduce((sum, row) => sum + (row.requests ?? 1), 0);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const activity = z.object({
  conversations: z.object({
    total: count,
    byModel: z.array(z.object({ model: z.string(), count })),
    days: z.array(z.object({ date: day, model: z.string(), count })),
  }),
  messages: z.object({ user: count, assistant: count, days: z.array(z.object({ date: day, user: count, assistant: count })) }),
  calls: z.object({ finished: count, failed: count, avgMs: z.number().nonnegative().nullable(), p95Ms: z.number().nonnegative().nullable() }),
});
export type AdminActivity = z.infer<typeof activity>;

async function readJson<T>(db: Db, source: string, name: string, args: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> {
  const result = await (db.rpc(name, args) as Page);
  if (result.error) throw new AdminActivityReadError(source, result.error.code ?? null);
  const parsed = shape.safeParse(result.data);
  if (!parsed.success) throw new AdminActivityReadError(source, null);
  return parsed.data;
}

/**
 * Conversations (all-time total and per model; per UTC day and model in [from, to)), messages by side (all-time; per day in the
 * window) and the finished model calls of [callsFrom, to) with their failures and duration.
 */
export const readAdminActivity = (db: Db, from: Date, to: Date, callsFrom: Date = from) => readJson(db, 'activity', 'turn_admin_activity',
  { p_from: from.toISOString(), p_to: to.toISOString(), p_calls_from: callsFrom.toISOString() }, activity);

const bucket = z.object({ count, amount: z.number().int() });
const dashboard = z.object({
  users: z.object({ total: count, today: count, week: count, month: count, credits: z.number().int() }),
  tickets: z.object({ total: count, open: count, inProgress: count, closed: count }),
  ledger: z.object({
    byType: z.record(z.string(), bucket),
    spent: count,
    days: z.array(z.object({ date: day, granted: count, spent: count })),
  }),
});
export type AdminDashboardStats = z.infer<typeof dashboard>;

/** Users, tickets and the credit ledger counted in the database: no table is read whole into Node. */
export const readAdminDashboardStats = (db: Db, today: Date, week: Date, month: Date) => readJson(db, 'dashboard', 'admin_dashboard_stats',
  { p_today: today.toISOString(), p_week: week.toISOString(), p_month: month.toISOString() }, dashboard);

/** Sum of the per-day rows on or after the UTC day of `since`. */
export function sumDaysSince<T extends { date: string }>(days: T[], since: Date, pick: (row: T) => number): number {
  const from = since.toISOString().slice(0, 10);
  return days.reduce((sum, row) => sum + (row.date >= from ? pick(row) : 0), 0);
}
