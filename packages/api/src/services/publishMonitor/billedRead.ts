/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readProviderPrices, resolveProviderPrice, resolveProviderMultipliers } from '../billingProviderPrices';
import { decimal } from '../turn/provider/decimal';
import type { BillingRpc } from '../turn/provider/service';
import { toolCallPolicy, type ToolCallPolicy } from '../turn/provider/toolBilling';
import { requestIdentity, ResearchPause, runSubcall, type EvidencePort, type SubcallContext, type SupplierRequest } from '../research/runtime/subcall';
import { TURN_BILLING_RUN } from '../research/runtime/store';
import { platformSecretReader } from '../research/runtime/secrets';
import { checkVendorRateLimit } from '../redisRateLimiter';
import { readResearchToolsConfig } from '../research/vendors/config';
import { tikhubRouteId, type TikhubCall } from '../research/vendors/tikhub';
import type { ResearchCallResult, SocialKind, SocialPlatform } from '../research/vendors/types';
import { readMultiplierSnapshot } from '../billingUnit';
import { TurnStop } from '../turn/call';
import { readCoreConfig } from '../turn/chat';
import { turnClients, turnDatabase, TurnDatabaseError } from '../turn/db';
import { startThresholdCredits, turnPolicy } from '../turn/policy';
import { readAdmissionConfiguration } from '../turn/admission/admissionConfiguration';
import { PRODUCTION_RESEARCH_ACCOUNT } from '../turn/research/researchTurn';
import { RESEARCH_THRESHOLDS_KEY } from '../turn/research/researchAdmission';
import { rowFor } from '../turn/settings/settingsRows';
import { paidToolCall, ToolLimitReached } from '../turn/tools/meter';
import { paidToolBounds } from '../turn/tools/plan';
import { settleLegacyRun } from './billedReadLegacy';
import type { ToolCallOutcome } from '../turn/tools/types';

/**
 * PUBLISH-MONITOR PR-4b (plan §6, §8), on the turn core since CORE-PATH-V2 V2-12 B8a: one billed TikHub read of a claimed
 * connection, outside a chat. Each refresh is one kind='review' turn (policy.review.mode = 'read') in the connection's hidden
 * conversation; its reads are ONE paid tool call (one turn_calls row, begin before the first request, record after the last), so
 * the user pays only for the subcalls that returned data, exactly as for a tool call of a chat. The price of each route is frozen
 * at the start and the start threshold of the phase must exist (as RESEARCH-TOOLS admission does). The evidence stays in the
 * billed-read ledger: a re-run of the same refresh re-applies a stored answer instead of calling and charging again (plan §8). A
 * request that was sent but never answered (a killed process) is a call without a receipt: the user pays nothing for it, the
 * turn recovery job settles the turn, and the request is sent again by the next run.
 */
type Admin = SupabaseClient;
type Env = Record<string, string | undefined>;
export const PUBLISH_MONITOR_PHASE = 'publish_monitor';
const RUN_MINUTES = 30;
const uuid = z.string().uuid();
const runView = z.object({ runId: uuid.nullable(), policies: z.array(z.unknown()).optional(), legacy: z.boolean().optional() }).passthrough();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class BilledReadError extends Error {
  constructor(readonly code: 'PUBLISH_MONITOR_TIKHUB_UNAVAILABLE' | 'PUBLISH_MONITOR_BILLING_UNAVAILABLE') { super(code); }
}

async function rpc<T>(admin: Pick<SupabaseClient, 'rpc'>, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const result = await admin.rpc(name, args);
  if (result.error) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
  return parsed.data;
}

/** The two reads of one connection: the account's profile and its newest posts. */
export function readRequests(platform: SocialPlatform, account: string): Array<{ kind: SocialKind; request: SupplierRequest }> {
  return (['account_profile', 'account_posts'] as const).map(kind => {
    const route = tikhubRouteId(platform, kind);
    if (!route) throw new BilledReadError('PUBLISH_MONITOR_TIKHUB_UNAVAILABLE');
    const call: TikhubCall = { platform, kind, account };
    return { kind, request: { vendor: 'tikhub' as const, route, call } };
  });
}

export type ClaimKeys = { connectionId: string; actorId: string; lease: string; refreshId: string };
const keyArgs = (k: ClaimKeys) => ({ p_connection_id: k.connectionId, p_lease: k.lease, p_refresh_id: k.refreshId });

export type ReadAdmission = { policies: ToolCallPolicy[]; q: string; multiplier: string; startCredits: number; bound: string;
  stopLoss: NonNullable<ReturnType<typeof readCoreConfig>>['stopLoss'] };

/**
 * Prices the routes one refresh needs and checks everything its turn needs before it opens: the core-path switch and stop-loss
 * parameters, the research and TikHub switches, a current price for each route, and one start threshold per route for this
 * phase (as RESEARCH-TOOLS admission does; production has no test window). null = TikHub reads are not available right now
 * (switched off, not priced or not configured): nothing is held and nothing is read.
 */
export async function admitReadTurn(admin: Admin, routes: string[], now = new Date()): Promise<ReadAdmission | null> {
  const configuration = readAdmissionConfiguration(admin);
  const core = readCoreConfig(await configuration);
  if (!core) return null;
  const tools = (await readResearchToolsConfig(admin, configuration)).config;
  if (!tools.enabled || !tools.vendors.tikhub.enabled) return null;
  const prices = await readProviderPrices(admin, configuration);
  const billingUnit = await readMultiplierSnapshot(admin, [], global => resolveProviderMultipliers(
    prices.config, routes.map(route => ({ provider: 'tikhub', route })), global, now));
  const deadline = now.getTime() + RUN_MINUTES * 60_000;
  const policies: ToolCallPolicy[] = [];
  for (const route of routes) {
    try {
      const policy = toolCallPolicy({ vendor: 'tikhub', account: PRODUCTION_RESEARCH_ACCOUNT, route, purposes: [PUBLISH_MONITOR_PHASE],
        maxUnitsPerCall: '1', price: resolveProviderPrice(prices.config, { provider: 'tikhub', route }, billingUnit.defaultMultiplier, now) });
      if (Date.parse(policy.toolPricing.validUntil) <= deadline) return null;
      policies.push(policy);
    } catch { return null; }
  }
  const multiplier = policies.reduce((max, policy) => decimal(policy.multiplier) > decimal(max) ? policy.multiplier : max, policies[0]!.multiplier);
  const setting = rowFor(await configuration, RESEARCH_THRESHOLDS_KEY);
  let startCredits = 0;
  for (const route of routes) {
    // Exactly one start threshold per route and purpose, or the read is refused (never a guessed threshold).
    const threshold = startThresholdCredits(setting.error ? null : setting.data?.value, `tikhub:${route}`, PUBLISH_MONITOR_PHASE,
      billingUnit.creditsPerUsd, multiplier);
    if (threshold === undefined) return null;
    startCredits = Math.max(startCredits, threshold);
  }
  const [bound] = paidToolBounds(policies, 1, routes.length, multiplier);
  return bound ? { policies, q: billingUnit.creditsPerUsd, multiplier, startCredits, bound, stopLoss: core.stopLoss } : null;
}

/**
 * A run left open by a killed process. Its live ledger attempts are freed (so their keys can be sent again) and it is marked
 * closed. A turn run is settled by the turn recovery job, nothing is settled from here; a legacy run (opened on BILL2 before
 * reads moved to turns) still gets its saved receipts replayed and its hold released (billedReadLegacy.ts). Idempotent.
 */
export async function settleLeftOpenRun(admin: Admin, actorId: string, runId: string, policies: unknown[], legacy = false) {
  if (legacy) { await settleLegacyRun(admin, actorId, runId, policies); return; }
  const rows = await rpc(admin, 'publish_monitor_billed_recovery', { p_run_id: runId }, z.array(z.object({ operationId: uuid, live: z.boolean() }).passthrough()));
  for (const row of rows.filter(item => item.live)) {
    await rpc(admin, 'publish_monitor_billed_abandon', { p_run_id: runId, p_operation_id: row.operationId }, z.boolean());
  }
  await rpc(admin, 'publish_monitor_billed_closed', { p_run_id: runId }, z.unknown());
}

/** The billed-read ledger as the RESEARCH-TOOLS evidence port, bound to the current claim and one request key. */
function ledgerPort(admin: Admin, keys: ClaimKeys, requestKey: string, model: string): EvidencePort {
  const step = (operationId: string, name: string, extra: { token?: string; callId?: string; state?: string; result?: unknown } = {}) =>
    rpc(admin, 'publish_monitor_billed_step', { ...keyArgs(keys), p_operation_id: operationId, p_step: name,
      p_request_key: requestKey, p_model: model, p_token: extra.token ?? null, p_call_id: extra.callId ?? null, p_state: extra.state ?? null,
      p_result: extra.result ?? null }, z.object({ ok: z.boolean() }).strict());
  const tokens = new Map<string, string>();
  return {
    async open(operationId) {
      const token = crypto.randomUUID();
      if (!(await step(operationId, 'open', { token })).ok) return null;
      tokens.set(operationId, token);
      return { token };
    },
    async dispatch(operationId, token) { return (await step(operationId, 'dispatch', { token })).ok; },
    async finish(operationId, token, state, result) { await step(operationId, 'finish', { token, state, result }); },
    async link(operationId, callId) {
      if (!(await step(operationId, 'link', { callId })).ok) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
    },
    async cancel(operationId) { await step(operationId, 'cancel', { token: tokens.get(operationId) }); },
  };
}

const storedResult = z.object({ vendor: z.literal('tikhub'), route: z.string(), outcome: z.enum(['ok', 'partial', 'failed', 'not_sent', 'unknown']),
  reason: z.string().nullable(), fetchedAt: z.string(), items: z.array(z.object({ url: z.string().optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), missing: z.array(z.string()) }).passthrough()),
  truncated: z.boolean(), usage: z.object({ unit: z.literal('call'), units: z.string().nullable() }).passthrough(),
  httpStatus: z.number().nullable(), supplierMayCharge: z.boolean() }).passthrough();

export type ReadOutcome =
  | { kind: 'read'; results: Partial<Record<SocialKind, ResearchCallResult>>; delivered: boolean }
  /** `results` holds what was already read and charged before the balance ran out (kept, not discarded). */
  | { kind: 'insufficient_credits'; results: Partial<Record<SocialKind, ResearchCallResult>> }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'stale' };

export type BilledReadDeps = { admin: Admin; env?: Env; now?: () => Date; vendors?: SubcallContext['vendors'];
  secrets?: SubcallContext['secrets']; rateCounter?: SubcallContext['rateCounter'] };

/**
 * Reads one claimed TikHub connection: stored answers of this refresh are re-used; anything else is sent as one billed tool call
 * of this refresh's turn. The turn is always closed before returning, so no hold stays frozen.
 */
export async function billedTikhubRead(deps: BilledReadDeps, keys: ClaimKeys, platform: SocialPlatform, account: string)
  : Promise<ReadOutcome> {
  const { admin } = deps;
  const requests = readRequests(platform, account);
  // A run left open by an earlier attempt of this refresh is freed first (its unanswered requests are sent again).
  const open = await rpc(admin, 'publish_monitor_billed_run', { ...keyArgs(keys), p_run_id: null, p_policies: null }, runView.nullable());
  if (open === null) return { kind: 'stale' };
  if (open.runId) await settleLeftOpenRun(admin, keys.actorId, open.runId, open.policies ?? [], open.legacy === true);
  const results: Partial<Record<SocialKind, ResearchCallResult>> = {};
  const missing: typeof requests = [];
  for (const item of requests) {
    const found = await rpc(admin, 'publish_monitor_billed_lookup', { ...keyArgs(keys), p_request_key: requestIdentity(item.request) },
      z.object({ stale: z.boolean(), found: z.boolean().optional(), state: z.string().optional(), result: z.unknown().optional() }).passthrough());
    if (found.stale) return { kind: 'stale' };
    const stored = found.found && found.state === 'answered' ? storedResult.safeParse(found.result) : null;
    if (stored?.success) results[item.kind] = stored.data as ResearchCallResult; else missing.push(item);
  }
  if (!missing.length) return { kind: 'read', results, delivered: false };
  let admitted: ReadAdmission | null;
  try { admitted = await admitReadTurn(admin, missing.map(item => item.request.route), deps.now?.()); }
  catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 64) : 'ADMISSION_FAILED' }; }
  if (!admitted) return { kind: 'unavailable', reason: 'TIKHUB_NOT_ADMITTED' };
  const db = turnDatabase(turnClients(admin));
  const sessionId = await rpc(admin, 'publish_monitor_session', { p_actor_id: keys.actorId, p_connection_id: keys.connectionId }, uuid);
  const requestId = randomUUID();
  const policy = turnPolicy({ q: admitted.q, multiplier: admitted.multiplier, modelUpperUsd: '0',
    // No model call is made; every tool return would be one more, so the call limit counts the one paid tool call.
    limits: { model: 2, paidTools: 1, freeTools: 0, decisions: 0 }, paidToolUpperUsd: [admitted.bound], stopLoss: admitted.stopLoss,
    historyItems: 0, inputBytes: 0, startThresholdCredits: admitted.startCredits });
  let opened;
  try {
    opened = await db.open({ actorId: keys.actorId, sessionId, requestId, kind: 'review',
      policy: { ...policy, review: { mode: 'read', connectionId: keys.connectionId, refreshId: keys.refreshId } } });
  } catch (error) {
    // The balance cannot start the read: nothing was held or charged; old data stays and the next daily run tries again.
    if (error instanceof TurnDatabaseError && error.code === 'TURN_INSUFFICIENT_CREDITS') return { kind: 'insufficient_credits', results };
    return { kind: 'unavailable', reason: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' };
  }
  const closeTurn = async (kind: 'completed' | 'failed', delivered: boolean) => {
    try { await db.close({ actorId: keys.actorId, turnId: opened.turnId, kind, messages: [], delivered }); }
    catch { throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE'); }
  };
  let bound;
  try { bound = await rpc(admin, 'publish_monitor_billed_run', { ...keyArgs(keys), p_run_id: requestId, p_policies: admitted.policies }, runView.nullable()); }
  catch (error) { await closeTurn('failed', false).catch(() => undefined); throw error; }
  // The claim is no longer current, or another process bound a run first: this turn was never used, close it at once.
  if (!bound?.runId || bound.runId !== requestId) {
    await closeTurn('failed', false);
    return bound === null ? { kind: 'stale' } : { kind: 'unavailable', reason: 'TIKHUB_NOT_ADMITTED' };
  }
  let sequence = 0, seq = 0;
  let last: ResearchCallResult | undefined;
  const calls = { db, actorId: keys.actorId, turnId: opened.turnId, nextSeq: () => ++seq };
  let outcome: ToolCallOutcome = 'not_sent';
  let stopped: ReadOutcome | null = null;
  try {
    const call = await paidToolCall(calls, { toolName: 'publish_monitor_read', upperUsd: admitted.bound, multiplier: admitted.multiplier,
      requestHash: sha256(missing.map(item => requestIdentity(item.request)).join(',')) }, async ledger => {
      for (const item of missing) {
        const context: SubcallContext = { policies: admitted!.policies, phase: PUBLISH_MONITOR_PHASE,
          // The tool row above is the charge; a subcall only reports what came back (turn/tools/benchmark.ts does the same).
          // The receipt that decides the charge is the FINAL one, recorded after the evidence was stored: when storing the answer
          // failed the subcall downgrades it (failed_charged / unknown), and then the user is not charged for data that was not kept.
          billing: { runId: TURN_BILLING_RUN, async claim() { return { state: 'claimed', callId: randomUUID(), token: randomUUID() }; },
            dispatch: async () => true,
            async record(_callId, receipt) {
              const result = last;
              last = undefined;
              if (result) ledger.add({ result: receipt.toolOutcome === 'failed_charged' ? { ...result, outcome: 'failed', items: [] } : result,
                costUsd: receipt.toolOutcome === 'unknown' ? null : receipt.cost,
                multiplier: admitted!.policies.find(policy => policy.model === `tikhub:${result.route}`)?.multiplier ?? admitted!.multiplier });
              return { accountClosed: false, contentDeleted: false };
            } },
          evidence: ledgerPort(admin, keys, requestIdentity(item.request), `tikhub:${item.request.route}`),
          nextSequence: () => ++sequence,
          secrets: deps.secrets ?? platformSecretReader(admin as unknown as BillingRpc),
          rateCounter: deps.rateCounter ?? checkVendorRateLimit, newId: () => randomUUID(),
          onResult: result => { last = result; },
          ...(deps.vendors ? { vendors: deps.vendors } : {}), ...(deps.now ? { now: deps.now } : {}) };
        const sent = await runSubcall(context, item.request);
        if (!sent.sent) return { kind: 'unavailable', reason: sent.stop.slice(0, 64) } as ReadOutcome;
        results[item.kind] = sent.result;
      }
      return null;
    });
    outcome = call.outcome;
    stopped = call.value;
  } catch (error) {
    // A pause for credits, a used-up limit or a supplier/key outage stops before anything more is sent; what was sent is already
    // settled by the tool row, and a background read has no turn to resume: it settles for today and the next daily run tries again.
    stopped = error instanceof TurnStop && error.code === 'TURN_PAUSED_FOR_CREDITS' ? { kind: 'insufficient_credits', results }
      : error instanceof ResearchPause ? { kind: 'unavailable', reason: 'WAITING_RESUME' }
      : error instanceof TurnStop || error instanceof ToolLimitReached || error instanceof TurnDatabaseError
        ? { kind: 'unavailable', reason: error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code : 'TURN_CALL_LIMIT' }
        : null;
    if (stopped === null) { await closeTurn('failed', false).catch(() => undefined); throw error; }
  }
  const delivered = outcome === 'delivered';
  await closeTurn('completed', delivered);
  await rpc(admin, 'publish_monitor_billed_closed', { p_run_id: requestId }, z.unknown());
  return stopped ?? { kind: 'read', results, delivered };
}
