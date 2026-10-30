/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { swallow } from '../../lib/swallow';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import type { FusionPhase } from '../fusion/models';
import type { RuntimeCallGate } from '../runtime/newWorkGate';
import { modelCall, TurnStop, type ModelCall } from './call';
import { GATE_CODES } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind, type TurnClients } from './db';
import type { CounterStore } from './limiter';
import { callCredits, stopLossSettings } from './policy';

/*
 * CORE-PATH-V2 V2-7b: what compare and jury turns share. The database calls are the five turn steps through their fusion
 * wrappers (turn_fusion_open / _begin / _record / _close, 0430): a receipt and the answer the user sees are written in one
 * statement. A group's calls run in parallel, but turn_call_begin takes consecutive sequences, so the begins are sent one after
 * another, in the order the calls took their sequence; everything after the begin (send, identity, receipt) is parallel.
 */
export type FusionKind = 'compare' | 'jury' | 'jury_adopt';
export type Verdict = 'usable' | 'format_invalid' | 'revision_invalid' | 'no_delivery';
export type Judged = { verdict: Verdict; deliverable?: boolean };
export type GroupMember = { call: ModelCall; body: string; phase: FusionPhase; judge: (text: string) => Judged;
  onChunk?: (chunk: string) => void };
/** ok: the call has its final receipt (empty: the provider billed a response without an answer, settled as no delivery). */
export type MemberOutcome = { ok: true; text: string; verdict: Verdict; empty?: boolean } | { ok: false; code: string };

const opened = z.object({ turnId: z.number().int().positive(), state: z.string(), replay: z.boolean(),
  reservedCredits: z.number().int().nonnegative(), reviewId: z.string().uuid().nullable().optional(),
  compareId: z.string().uuid().nullable().optional() }).passthrough();
const closed = z.object({ turnId: z.number().int().positive(), closeKind: z.string(), chargedCredits: z.number().int().nullable(),
  settlement: z.enum(['pending', 'done']).nullable(), replay: z.boolean() }).passthrough();
const tombstones = { sessionTombstoned: z.boolean(), accountErasing: z.boolean(), voiceSourceRevoked: z.boolean() };
const begun = z.object({ state: z.enum(['running', 'paused']), status: z.string().optional(), replay: z.boolean().optional(),
  paused: z.boolean().optional(), ...tombstones });
const recorded = z.object({ status: z.string(), creditsLow: z.boolean(), productGone: z.boolean(), ...tombstones });
const outputSaved = z.object({ productGone: z.boolean(), ...tombstones });
const KNOWN = /\b((?:TURN|FUSION)_[A-Z_]+|STOP_LOSS_REACHED)\b/;
async function rpc<T>(client: TurnClients['write'], name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new TurnDatabaseError(KNOWN.exec(error.message ?? '')?.[1] ?? 'TURN_DATABASE_UNAVAILABLE');
  return schema.parse(data);
}

const breakerUsage = z.object({ noDeliveryCalls: z.number(), platformUsd: z.union([z.number(), z.string()]) }).passthrough();
const compareAdmit = z.object({ history: z.array(z.object({ seq: z.number().int(), role: z.enum(['user', 'assistant']),
  content: z.string() })), positioned: z.boolean(), breaker: breakerUsage });
const reviewSource = z.object({ draftId: z.string(), projectId: z.string(), sessionId: z.string(), sourceVersionId: z.string(),
  versionHash: z.string(), materials: z.record(z.string(), z.unknown()), breaker: breakerUsage });
const READ_CODE = /\b((?:TURN|FUSION|OPC)_[A-Z_]+|CONTENT_ERASED)\b/;
async function read<T>(client: TurnClients['write'], name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new TurnDatabaseError(READ_CODE.exec(error.message ?? '')?.[1] ?? 'TURN_DATABASE_UNAVAILABLE');
  return schema.parse(data);
}

/** The 7-day platform cost breaker (§3.6): the statistic read before the open against the administrator's thresholds. */
export const breakerTripped = (usage: z.infer<typeof breakerUsage>, limits: { platformUsd: string; noDeliveryCalls: number }) =>
  usage.noDeliveryCalls >= limits.noDeliveryCalls || Number(usage.platformUsd) >= Number(limits.platformUsd);

/**
 * What a compare or a jury start reads before it opens, by the owner's keys (ENGINEERING 5, as V2-7a's report_source): the old
 * permission chain stays out of turn_fusion_open, which keeps only the checks that must be atomic. On the write connection:
 * that chain takes short share locks and keeps its check memo, which a read replica or a read-only transaction refuses.
 */
export function fusionAdmission(clients: TurnClients, actorId: string) {
  return {
    compare: (sessionId: string, limit: number, dependencies: Array<{ sourceVersionId: string }>) => read(clients.write,
      'fusion_compare_turn_admit', { p_actor_id: actorId, p_session_id: sessionId, p_limit: limit, p_dependencies: dependencies },
      compareAdmit),
    reviewSource: (a: { requestId: string; draftId: string; sourceVersionId: string }) => read(clients.write, 'fusion_review_turn_source',
      { p_actor_id: actorId, p_request_id: a.requestId, p_draft_id: a.draftId, p_source_version_id: a.sourceVersionId }, reviewSource),
  };
}

export function fusionDatabase(clients: TurnClients, actorId: string) {
  const w = clients.write, core = turnDatabase(clients);
  return {
    open: (a: { sessionId: string; requestId: string; kind: FusionKind; policy: Record<string, unknown>; product: Record<string, unknown> }) =>
      rpc(w, 'turn_fusion_open', { p_actor_id: actorId, p_session_id: a.sessionId, p_request_id: a.requestId, p_kind: a.kind,
        p_policy: a.policy, p_product: a.product }, opened),
    close: (a: { turnId: number; kind: CloseKind; delivered: boolean; refundAll?: boolean; failureCode?: string | null;
      product?: Record<string, unknown> }) =>
      rpc(w, 'turn_fusion_close', { p_actor_id: actorId, p_turn_id: a.turnId, p_close_kind: a.kind, p_delivered: a.delivered,
        p_refund_all: a.refundAll ?? false, p_failure_code: a.failureCode ?? null, p_product: a.product ?? {} }, closed),
    /** The answer of a call whose cost is not final yet: saved and judged, the call left for recovery (turn_fusion_output). */
    output: (turnId: number, seq: number, output: Record<string, unknown>) =>
      rpc(w, 'turn_fusion_output', { p_actor_id: actorId, p_turn_id: turnId, p_seq: seq, p_output: output }, outputSaved),
    /** The three call writes for one turn, as modelCall uses them (TurnDatabase's shape). */
    calls(turnId: number, output: (seq: number, raw: string | null) => { status: 'ok' | 'unusable'; usage: Record<string, unknown>;
      output: Record<string, unknown> | null } | null) {
      let queue: Promise<unknown> = Promise.resolve();
      return {
        ...core,
        begin(a: Parameters<typeof core.begin>[0]) {
          const next = queue.then(() => rpc(w, 'turn_fusion_begin', { p_actor_id: actorId, p_turn_id: turnId, p_seq: a.seq,
            p_call_kind: a.callKind, p_model_id: a.modelId, p_tool_name: a.toolName, p_paid: a.paid, p_request_hash: a.requestHash,
            p_upper_usd: a.upperUsd, p_multiplier: a.multiplier }, begun));
          // The chain only orders the begins; this begin's own failure reaches its caller through `next`.
          queue = swallow('turn_fusion_begin_queue', next, undefined, { category: 'ai' });
          return next;
        },
        async record(a: Parameters<typeof core.record>[0]) {
          const judged = a.status === 'ok' ? output(a.seq, a.raw) : null;
          const result = await rpc(w, 'turn_fusion_record', { p_actor_id: actorId, p_turn_id: turnId, p_seq: a.seq,
            p_status: judged?.status ?? a.status, p_nominal_usd: judged?.status === 'unusable' ? null : a.nominalUsd,
            p_actual_usd: a.actualUsd, p_usage: { ...a.usage, ...judged?.usage }, p_provider_id: a.providerId,
            p_payload_hash: a.payloadHash, p_raw: a.raw, p_output: judged?.output ?? null }, recorded);
          // A deleted review or compare stops the turn like a tombstone: nothing more is sent or saved.
          return { ...result, sessionTombstoned: result.sessionTombstoned || result.productGone };
        },
      };
    },
  };
}
export type FusionDatabase = ReturnType<typeof fusionDatabase>;

/** The answer text of a completed streamed response, as the receipt stores it (the SDK response JSON of openRouterEvidence). */
export function answerText(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const content = (JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    return typeof content === 'string' && content.length ? content : null;
  } catch { return null; }
}

export type GroupContext = { db: FusionDatabase; slots: CounterStore; actorId: string; turnId: number;
  /** The one-switch pause and the account's call limits (runtime/newWorkGate.ts), before every paid call, as the old path. */
  calls: RuntimeCallGate;
  /** The next free call sequence of the turn (shared by every group of it). */
  nextSeq: () => number; credential: () => Promise<string>; transport?: typeof fetch; sleep?: (ms: number) => Promise<void> };

/** Runs one group's calls in parallel. Each call is judged on its exact saved text before the receipt is written (a format
 * failure is 'unusable': the platform keeps its cost, the user's base is 0); a call that is not delivered ends with its code. */
export async function runGroup(ctx: GroupContext, members: GroupMember[]): Promise<MemberOutcome[]> {
  const bySeq = new Map<number, GroupMember>(), lastSeq = new Map<GroupMember, number>();
  const texts = new Map<GroupMember, { text: string; verdict: Verdict; empty?: boolean }>();
  const calls = ctx.db.calls(ctx.turnId, (seq, raw) => {
    const member = bySeq.get(seq);
    if (!member) return null;
    const text = answerText(raw);
    if (!text) {
      texts.set(member, { text: '', verdict: 'no_delivery', empty: true });
      return { status: 'unusable', usage: { verdict: 'no_delivery' }, output: null };
    }
    const judged = member.judge(text);
    texts.set(member, { text, verdict: judged.verdict });
    if (judged.verdict === 'no_delivery') return { status: 'unusable', usage: { verdict: 'no_delivery' }, output: null };
    return { status: judged.verdict === 'usable' ? 'ok' : 'unusable',
      usage: { verdict: judged.verdict, ...(judged.deliverable ? { deliverable: true } : {}) },
      output: { phase: member.phase, body: text, verdict: judged.verdict, ...(judged.deliverable ? { deliverable: true } : {}) } };
  });
  const adapter = openRouterAdapter({ allowWorkspaceRead: true, credential: ctx.credential, transport: ctx.transport });
  const settled = await Promise.allSettled(members.map(async member => {
    // The pause and the call limits before the call is begun or sent (the old path's call gate): a refusal writes nothing.
    const gate = await ctx.calls(ctx.actorId, 1, 'bill2.v2');
    if (!gate.ok) throw new TurnStop(GATE_CODES[gate.reason]);
    const deps = { db: calls as never, adapter, slots: ctx.slots, actorId: ctx.actorId, turnId: ctx.turnId, sleep: ctx.sleep,
      nextSeq: () => { const seq = ctx.nextSeq(); bySeq.set(seq, member); lastSeq.set(member, seq); return seq; } };
    return modelCall(deps, member.call, member.body, member.onChunk);
  }));
  return Promise.all(settled.map(async (result, index): Promise<MemberOutcome> => {
    const member = members[index]!, saved = texts.get(member);
    if (result.status === 'fulfilled') {
      if (saved) return { ok: true, ...saved };
      // A complete answer whose cost is not final yet (modelCall returned it without a receipt): the answer is kept and
      // judged now; the call stays open for recovery to settle its cost by the provider id (2.5.2).
      const text = answerText(result.value), seq = lastSeq.get(member);
      if (seq === undefined) return { ok: false, code: 'TURN_CALL_UNKNOWN' };
      // A completed call without an answer delivers nothing, as one whose cost is known at once (the placeholder is never read).
      const judged: Judged = text ? member.judge(text) : { verdict: 'no_delivery' };
      // A refused or empty column is saved too (never shown): its cost settled later by recovery is then never charged to the user.
      try {
        const kept = await ctx.db.output(ctx.turnId, seq, { phase: member.phase, body: text || '(empty)', verdict: judged.verdict,
          ...(judged.deliverable ? { deliverable: true } : {}) });
        if (kept.productGone || kept.sessionTombstoned || kept.accountErasing) return { ok: false, code: 'TURN_TOMBSTONED' };
      } catch (error) { return { ok: false, code: error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED' }; }
      return text ? { ok: true, text, verdict: judged.verdict } : { ok: true, text: '', verdict: 'no_delivery', empty: true };
    }
    const error = result.reason;
    return { ok: false, code: error instanceof TurnStop || error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED' };
  }));
}

/** The frozen numbers of a compare or jury turn (2.5.3): no tools, M model calls, each bounded on its own; q the same for all. */
export const fusionCoreSetting = z.object({ enabled: z.boolean(), stopLoss: stopLossSettings }).passthrough();
export function fusionPolicy(input: { q: string; calls: Array<{ upperUsd: string; multiplier: string }>;
  /** Credits frozen for the user (G_turn) and the start threshold. */
  gCredits: number; minCredits: number; fixedCredits?: number; stopLoss: z.infer<typeof stopLossSettings>;
  /** The positioning check's platform bound (compare): one 'decision' call outside M, in U_turn, never in G (Fable 10-28). */
  decisionUpperUsd?: string; historyItems?: number; frozen?: Record<string, string | number | boolean>;
  /** The models the turn may call and their nominal prices, by model id: recovery settles a call whose cost is unknown with
   * them (turn_recovery_claim reads policy.models / policy.pricings for multi-model kinds). */
  quotes: ReadonlyArray<{ modelId: string; model: string; pricing: unknown }> }) {
  const SCALE = 10n ** 12n;
  const units = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0').slice(0, 12));
  };
  const total = input.calls.reduce((sum, c) => sum + units(c.upperUsd), 0n)
    + (input.decisionUpperUsd === undefined ? 0n : units(input.decisionUpperUsd));
  const fraction = (total % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  const uModelCredits = Math.max(0, ...input.calls.map(c => callCredits(input.q, c.upperUsd, c.multiplier)));
  return {
    ...input.frozen,
    models: Object.fromEntries(input.quotes.map(quote => [quote.modelId, quote.model])),
    pricings: Object.fromEntries(input.quotes.map(quote => [quote.modelId, quote.pricing])),
    q: Number(input.q), uTurnUsd: Number(`${total / SCALE}${fraction ? '.' + fraction : ''}`),
    gCredits: input.gCredits, minCredits: input.minCredits,
    uModelCredits, ...(input.fixedCredits === undefined ? {} : { fixedCredits: input.fixedCredits }),
    ...(input.decisionUpperUsd === undefined ? {} : { decisionUpperUsd: input.decisionUpperUsd }),
    limits: { model: Math.max(1, input.calls.length), paidTools: 0, freeTools: 0, decisions: input.decisionUpperUsd === undefined ? 0 : 1 },
    stopLoss: stopLossSettings.parse(input.stopLoss), historyItems: input.historyItems ?? 0, inputBytes: 0,
  };
}
