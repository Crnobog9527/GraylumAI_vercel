/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { resumeRead } from './resume';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * CORE-PATH-V2 (docs/launch/tasks/CORE-PATH-V2.md 2.2, 2.5.2, 3.3.2 item 5): the only database calls of a turn.
 * A turn writes three ways: turn_open, the call lifecycle (turn_call_begin / turn_call_identity / turn_call_record) and
 * turn_close (0421). They all go to the write client. The read client is the seam for a read replica (history pages, credit
 * records, reports); today both point at the primary database, and a replica is a configuration change only.
 */
export type TurnClients = { write: Pick<SupabaseClient, 'rpc'>; read: Pick<SupabaseClient, 'rpc' | 'from'> };
export function turnClients(primary: SupabaseClient, replica?: SupabaseClient): TurnClients {
  return { write: primary, read: replica ?? primary };
}

const tombstones = z.object({ sessionTombstoned: z.boolean(), accountErasing: z.boolean(), voiceSourceRevoked: z.boolean() });
export type Tombstones = z.infer<typeof tombstones>;
export const tombstoned = (t: Tombstones) => t.sessionTombstoned || t.accountErasing || t.voiceSourceRevoked;

const historyItem = z.object({ seq: z.number().int().positive(), role: z.enum(['user', 'assistant']), content: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type HistoryItem = z.infer<typeof historyItem>;
const opened = z.object({ turnId: z.number().int().positive(), state: z.enum(['running', 'paused', 'closed', 'stopping', 'opening']),
  replay: z.boolean(), reservedCredits: z.number().int().nonnegative(), reservedUsd: z.coerce.number().nonnegative(),
  history: z.array(historyItem), resumeOf: z.number().int().positive().nullable().optional(),
  // Read by turn_open with the account row: the reply language setting and, for a free chat, the positioning gate.
  replyLanguage: z.unknown().optional(),
  positioning: z.object({ positioned: z.boolean(), refusals24h: z.number().int().nonnegative() }).nullable().optional(),
  // The per-kind hook: what a kind's prompt needs, built by its branch in turn_open (null until a kind adds one).
  kindContext: z.unknown().optional() });
export type Opened = z.infer<typeof opened>;
const begun = tombstones.extend({ state: z.enum(['running', 'paused']), status: z.string().optional(),
  replay: z.boolean().optional(), paused: z.boolean().optional() });
export type Begun = z.infer<typeof begun>;
const recorded = tombstones.extend({ status: z.string(), creditsLow: z.boolean() });
export type Recorded = z.infer<typeof recorded>;
const closed = z.object({ turnId: z.number().int().positive(), closeKind: z.string(), chargedCredits: z.number().int().nullable(),
  absorbedCredits: z.number().int().nullable(), settlement: z.enum(['pending', 'done']).nullable(), replay: z.boolean(),
  // What the kind's close function returned (the mentor's checklist capture), when it has one.
  kindResult: z.unknown().optional() })
  .and(tombstones.partial());
export type Closed = z.infer<typeof closed>;

export type RecoveryAction = 'interrupt' | 'expire' | 'settle';
export type ClaimAction = RecoveryAction | 'lookup';
const recoveryClaim = z.array(z.object({ actorId: z.string().uuid(), turnId: z.number().int().positive(),
  action: z.enum(['interrupt', 'expire', 'settle', 'lookup']),
  /** settle, lookup: the model costs not final yet, to look up by provider id (lookup: of a turn paused for credits). */
  /** model and pricing are the ones the turn froze at open (policy), never the catalog's current values. */
  calls: z.array(z.object({ seq: z.number().int().positive(), providerId: z.string().min(1), model: z.string().nullable(),
    pricing: z.unknown().nullable().optional(), upperUsd: z.coerce.string() })) })).max(50);
export type RecoveryItem = z.infer<typeof recoveryClaim>[number];
const recovered = z.object({ action: z.enum(['interrupt', 'expire', 'settle']), skipped: z.boolean().optional(),
  closeKind: z.string().optional(), settlement: z.enum(['pending', 'done']).nullable().optional() }).passthrough();
export type Recovered = z.infer<typeof recovered>;
const stopped = z.object({ turnId: z.number().int().positive(), state: z.enum(['stopping', 'closed', 'confirmation_required']),
  chargeable: z.boolean(), replay: z.boolean(), closeKind: z.string().nullable().optional(),
  chargedCredits: z.number().int().nullable().optional(), fixedCredits: z.number().int().optional() });
export type Stopped = z.infer<typeof stopped>;
const reportTurn = z.object({ turnId: z.number().int().positive(), requestId: z.string().uuid(),
  state: z.enum(['opening', 'running', 'stopping', 'paused', 'closed']),
  closeKind: z.string().nullable(), delivered: z.boolean(), chargedCredits: z.number().int().nullable(),
  settlement: z.enum(['pending', 'done']).nullable(), fixedCredits: z.number().int().nullable(), stopChargeable: z.boolean().nullable(),
  report: z.record(z.string(), z.unknown()).nullable(), body: z.string().nullable(), openedAt: z.string(), closedAt: z.string().nullable() });
export type ReportTurn = z.infer<typeof reportTurn>;

export type CallKind = 'model' | 'tool' | 'decision';
export type CallStatus = 'ok' | 'not_sent' | 'rejected' | 'no_charge_402' | 'unusable';
export type CloseKind = 'completed' | 'failed' | 'interrupted' | 'expired' | 'erased' | 'stopped';

/** A database error keeps its code (TURN_SESSION_BUSY, STOP_LOSS_REACHED, ...) and nothing else of the database's text. */
export class TurnDatabaseError extends Error {
  constructor(readonly code: string) { super(code); }
}
// A kind's own refusals (a report's REPORT_*, an archived business, V2-7a) keep their codes too.
const KNOWN = /\b(TURN_[A-Z_]+|REPORT_[A-Z_]+|STOP_LOSS_REACHED|OPC_BUSINESS_ARCHIVED)\b/;
async function call<T>(client: Pick<SupabaseClient, 'rpc'>, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new TurnDatabaseError(KNOWN.exec(error.message ?? '')?.[1] ?? 'TURN_DATABASE_UNAVAILABLE');
  return schema.parse(data);
}

export function turnDatabase(clients: TurnClients) {
  const w = clients.write;
  return {
    /** resumeOf: the session's turn paused for credits, continued by this one (V2-8); its limits are what that turn has left. */
    open: (a: { actorId: string; sessionId: string; requestId: string; kind: string; policy: Record<string, unknown>; resumeOf?: number }) =>
      call(w, 'turn_open', { p_actor_id: a.actorId, p_session_id: a.sessionId, p_request_id: a.requestId, p_kind: a.kind,
        p_policy: a.policy, p_resume_of: a.resumeOf ?? null }, opened),
    begin: (a: { actorId: string; turnId: number; seq: number; callKind: CallKind; modelId: string | null; toolName: string | null;
      paid: boolean | null; requestHash: string; upperUsd: string; multiplier: string }) =>
      call(w, 'turn_call_begin', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_seq: a.seq, p_call_kind: a.callKind,
        p_model_id: a.modelId, p_tool_name: a.toolName, p_paid: a.paid, p_request_hash: a.requestHash, p_upper_usd: a.upperUsd,
        p_multiplier: a.multiplier }, begun),
    identity: (a: { actorId: string; turnId: number; seq: number; providerId: string }) =>
      call(w, 'turn_call_identity', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_seq: a.seq, p_provider_id: a.providerId },
        z.object({ status: z.string() })),
    record: (a: { actorId: string; turnId: number; seq: number; status: CallStatus; nominalUsd: string | null; actualUsd: string | null;
      usage: Record<string, unknown>; providerId: string | null; payloadHash: string; raw: string | null }) =>
      call(w, 'turn_call_record', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_seq: a.seq, p_status: a.status,
        p_nominal_usd: a.nominalUsd, p_actual_usd: a.actualUsd, p_usage: a.usage, p_provider_id: a.providerId,
        p_payload_hash: a.payloadHash, p_raw: a.raw }, recorded),
    close: (a: { actorId: string; turnId: number; kind: CloseKind; messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      delivered: boolean; refundAll?: boolean; failureCode?: string | null;
      /** The per-kind hook: what the kind keeps from its result, written by its function in the close transaction. */
      kindResult?: unknown }) =>
      call(w, 'turn_close', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_close_kind: a.kind, p_messages: a.messages,
        p_delivered: a.delivered, p_refund_all: a.refundAll ?? false, p_failure_code: a.failureCode ?? null,
        p_kind_result: a.kindResult ?? null }, closed),
    /** The recovery job (V2-8): claim up to 50 turns under a lease, then recover each one in its own transaction. */
    claimRecovery: (limit: number) => call(w, 'turn_recovery_claim', { p_limit: limit }, recoveryClaim),
    recover: (a: { actorId: string; turnId: number; action: RecoveryAction }) =>
      call(w, 'turn_recover', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_action: a.action }, recovered),
    /** The user's stop of a running report (V2-7a); not part of a turn's own writes. */
    stop: (a: { actorId: string; turnId: number; confirmed: boolean; stopAt: number | null }) =>
      call(w, 'turn_stop', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_confirmed: a.confirmed, p_stop_at: a.stopAt }, stopped),
    /** A report turn of a round (newest, or by id), with its saved text. */
    /** At a pause, once: what the user asked, for the resume (resume.ts). */
    pauseSave: (a: { actorId: string; turnId: number; input: Record<string, unknown> }) =>
      call(clients.write, 'turn_pause_save', { p_actor_id: a.actorId, p_turn_id: a.turnId, p_input: a.input }, z.boolean()),
    /** What a resume replays (resume.ts): read once before it opens. */
    resumeRead: (a: { actorId: string; sessionId: string; turnId: number }) =>
      call(clients.read, 'turn_resume_read', { p_actor_id: a.actorId, p_session_id: a.sessionId, p_turn_id: a.turnId }, resumeRead),
    reportRead: (a: { actorId: string; sessionId: string; roundId: string | null; turnId: number | null }) =>
      call(clients.read, 'turn_report_read', { p_actor_id: a.actorId, p_session_id: a.sessionId, p_round_id: a.roundId,
        p_turn_id: a.turnId }, reportTurn.nullable()),
    // A report's reads before it opens (controller 10-30, B1), on the read client and by the actor's own keys: the confirmed
    // source of its round, the session's benchmark table, and the benchmark shortfall card (only when the table is short).
    // The report membership check of the old admission (payment facts, refunds, the subscription's period end; never only the
    // cached level): on the write client, as it takes the account's own row lock to serialize with paid fulfilment.
    reportMembership: (a: { actorId: string }) =>
      call(w, 'report_membership_check', { p_actor_id: a.actorId }, z.unknown()),
    reportSource: (a: { actorId: string; sessionId: string; projectId: string; roundId: string }) =>
      call(clients.read, 'report_source', { p_actor_id: a.actorId, p_session_id: a.sessionId, p_project_id: a.projectId,
        p_round_id: a.roundId }, z.record(z.string(), z.unknown())),
    benchmarkRows: (a: { actorId: string; sessionId: string }) =>
      call(clients.read, 'research_benchmark_rows', { a: a.actorId, s: a.sessionId }, z.unknown()),
    benchmarkShortfall: (a: { actorId: string; sessionId: string }) =>
      call(clients.read, 'research_user_shortfall', { a: a.actorId, s: a.sessionId }, z.unknown()),
  };
}
export type TurnDatabase = ReturnType<typeof turnDatabase>;
