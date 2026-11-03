/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect } from '@playwright/test';

import { coreSql } from './db';

/** A turn row as the read-only evidence role sees it (README, "只读数据库角色": no opened_at, no policy). */
export interface TurnRow {
  id: string; kind: string; state: string; closeKind: string | null; settlement: string | null;
  charged: number | null; reserved: number; stoppedByUser: boolean; sessionId: string | null; closedAt: string | null;
}

const columns = (rows: Array<Record<string, unknown>>): TurnRow[] => rows.map(row => ({
  id: String(row.id), kind: String(row.kind), state: String(row.state), closeKind: (row.close_kind as string | null) ?? null,
  settlement: (row.settlement as string | null) ?? null, charged: (row.charged_credits as number | null) ?? null,
  reserved: Number(row.reserved_credits ?? 0), stoppedByUser: Boolean(row.stopped_by_user), sessionId: (row.session_id as string | null) ?? null,
  closedAt: (row.closed_at as string | null) ?? null,
}));

/** The newest turn id of the account, so a step can count exactly the turns it opened (turn ids only grow). */
export async function lastTurnId(actorId: string): Promise<string> {
  const rows = await coreSql()<Array<{ id: string }>>`select coalesce(max(id), 0)::text as id from turns where actor_id = ${actorId}::uuid`;
  return rows[0]?.id ?? '0';
}

export async function turnsAfter(actorId: string, afterId: string): Promise<TurnRow[]> {
  return columns(await coreSql()`
    select id::text, kind, state, close_kind, settlement, charged_credits, reserved_credits, stopped_by_user, session_id::text, closed_at::text
    from turns where actor_id = ${actorId}::uuid and id > ${afterId}::bigint order by id`);
}

/** Every turn of these accounts that this run touched (closed since it started), plus any that is still open, whenever it began. */
export async function runTurns(actorIds: readonly string[], sinceIso: string): Promise<TurnRow[]> {
  return columns(await coreSql()`
    select id::text, kind, state, close_kind, settlement, charged_credits, reserved_credits, stopped_by_user, session_id::text, closed_at::text
    from turns where actor_id = any(${actorIds as string[]}::uuid[]) and (state <> 'closed' or closed_at >= ${sinceIso}::timestamptz)
    order by id`);
}

/** A turn leaves nothing frozen once it is closed and settled (a turn that never held credits needs no settlement). */
export const leavesNothingFrozen = (turn: TurnRow) => turn.state === 'closed' && (turn.settlement === 'done' || turn.reserved === 0);

/** Waits until the turns opened after `afterId` are closed and settled, then returns them. */
export async function settledTurnsAfter(actorId: string, afterId: string, timeoutMs = 180_000): Promise<TurnRow[]> {
  await expect.poll(async () => (await turnsAfter(actorId, afterId)).filter(turn => !leavesNothingFrozen(turn)).map(turn => `${turn.id}:${turn.state}/${turn.settlement}`),
    { message: 'every turn this step opened is closed and settled', timeout: timeoutMs, intervals: [2000, 5000] }).toEqual([]);
  return turnsAfter(actorId, afterId);
}
