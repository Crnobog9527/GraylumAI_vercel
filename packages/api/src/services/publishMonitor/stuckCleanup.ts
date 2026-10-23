/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * PUBLISH-MONITOR plan §9 item 25: Post for Me cleanup that stopped after 50 failed attempts (a deletion or takeover
 * disconnect, or a connect attempt's cleanup) is listed for the admin page and the job's alert, and can be re-queued
 * once a person has looked at it (migration 0337, definer functions only).
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const code = z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable();
const stuckSchema = z.object({
  totals: z.object({ connections: z.number().int().min(0), requests: z.number().int().min(0) }).strict(),
  connections: z.array(z.object({ id: z.string().uuid(), kind: z.enum(['deletion', 'takeover_disconnect']),
    platform: z.string(), providerAccountId: z.string().nullable(), attempts: z.number().int(), error: code,
    updatedAt: z.string() }).strict()),
  requests: z.array(z.object({ id: z.string().uuid(), platform: z.string(), state: z.enum(['applied', 'abandoned']),
    attempts: z.number().int(), error: code, createdAt: z.string(), providerAccountIds: z.array(z.string()) }).strict()),
}).strict();
export type StuckCleanup = z.infer<typeof stuckSchema>;

export async function readStuckCleanup(db: Rpc, limit = 200): Promise<StuckCleanup> {
  const result = await db.rpc('publish_monitor_stuck_list', { p_limit: limit });
  if (result.error) throw new Error('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
  const parsed = stuckSchema.safeParse(result.data);
  if (!parsed.success) throw new Error('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
  return parsed.data;
}

export const requeueInput = z.object({ kind: z.enum(['connection', 'request']), id: z.string().uuid() }).strict();
export async function requeueStuckCleanup(db: Rpc, input: z.infer<typeof requeueInput>): Promise<{ requeued: boolean }> {
  const result = await db.rpc('publish_monitor_stuck_requeue', { p_kind: input.kind, p_id: input.id });
  if (result.error || typeof result.data !== 'boolean') throw new Error('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
  return { requeued: result.data };
}

/**
 * A person verified at Post for Me that the account is already gone: ends the record (the worker alone would keep failing,
 * because Post for Me answers 500, not 404, for an unknown account).
 */
export async function resolveStuckCleanup(db: Rpc, input: z.infer<typeof requeueInput>): Promise<{ resolved: boolean }> {
  const result = await db.rpc('publish_monitor_stuck_resolve', { p_kind: input.kind, p_id: input.id });
  if (result.error || typeof result.data !== 'boolean') throw new Error('PUBLISH_MONITOR_STUCK_UNAVAILABLE');
  return { resolved: result.data };
}
