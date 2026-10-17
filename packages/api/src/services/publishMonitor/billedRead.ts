/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readProviderPrices, resolveProviderPrice } from '../billingProviderPrices';
import { decimal } from '../bill2/decimal';
import type { BillingRpc } from '../bill2/service';
import { frozenToolPolicy, toolCallPolicy, toolModelId, toolResultEvidence, type ToolCallPolicy } from '../bill2/toolBilling';
import { toolSubcallBilling } from '../bill2/toolSubcall';
import { requestIdentity, runSubcall, type EvidencePort, type SubcallContext, type SupplierRequest } from '../research/runtime/subcall';
import { platformSecretReader } from '../research/runtime/secrets';
import { checkVendorRateLimit } from '../redisRateLimiter';
import { readResearchToolsConfig } from '../research/vendors/config';
import { tikhubRouteId, type TikhubCall } from '../research/vendors/tikhub';
import type { ResearchCallResult, SocialKind, SocialPlatform } from '../research/vendors/types';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { derivedUuid } from '../fusion/admission';

/**
 * PUBLISH-MONITOR PR-4b (plan §6, §8): one billed TikHub read of a claimed connection, outside a chat turn.
 * Each refresh bills on its own sessionless PAYG v2 run that freezes only the TikHub routes it may use (Owner
 * 2026-10-17 approved this tool-only run shape, migration 0290). Each supplier request is the RESEARCH-TOOLS subcall
 * (price frozen at the start, hold, dispatch, record), with the evidence kept in the billed-read ledger: a re-run of the
 * same refresh re-applies a stored answer instead of calling and charging again (plan §8). A request that was sent but
 * never answered (a killed process) settles at zero for the user before anything is resent.
 */
type Admin = SupabaseClient;
type Env = Record<string, string | undefined>;
export const PUBLISH_MONITOR_PHASE = 'publish_monitor';
/** Same id as SQL bill2_tool_model_id('publish-monitor:read-run') (0290 publish_monitor_tool_only_run). */
export const READ_RUN_MODEL_ID = toolModelId('publish-monitor:read-run');
const RUN_MINUTES = 30;
const uuid = z.string().uuid();
const runView = z.object({ runId: uuid.nullable(), policies: z.array(z.unknown()).optional() }).passthrough();

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

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);

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

/**
 * Freezes and prepares the run of one refresh: only the routes it needs, each with the price, purpose and threshold
 * the staging window approves (as RESEARCH-TOOLS admission does). null = TikHub reads are not available right now
 * (switched off, not priced, or not approved): nothing is held and nothing is read.
 */
export async function admitReadRun(admin: Admin, keys: ClaimKeys, routes: string[], env: Env, now = new Date())
  : Promise<{ runId: string; policies: ToolCallPolicy[] } | null> {
  const tools = (await readResearchToolsConfig(admin)).config;
  if (!tools.enabled || !tools.vendors.tikhub.enabled) return null;
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, keys.actorId, env);
  const billingUnit = await freezeWindowBillingUnit(admin, window, []);
  const [prices, thresholds] = await Promise.all([readProviderPrices(admin), admin.from('system_settings').select('value')
    .eq('key', 'billing_payg_start_thresholds').maybeSingle()]);
  const entries = z.object({ thresholds: z.array(z.object({ model: z.string(), purpose: z.string() }).passthrough()) })
    .passthrough().safeParse(thresholds.data?.value);
  if (!entries.success) return null;
  const deadline = new Date(Math.min(now.getTime() + RUN_MINUTES * 60_000, Date.parse(window.expiresAt) - 60_000));
  const policies: ToolCallPolicy[] = [];
  for (const route of routes) {
    const model = `tikhub:${route}`;
    const approved = window.toolPolicies?.find(policy => policy.model === model);
    // Exactly one start threshold per route and purpose (0180), as the claim requires.
    if (!approved || entries.data.thresholds.filter(t => t.model === model && t.purpose === PUBLISH_MONITOR_PHASE).length !== 1) {
      return null;
    }
    let policy: ToolCallPolicy;
    try {
      policy = toolCallPolicy({ vendor: 'tikhub', account: approved.account, route, purposes: [PUBLISH_MONITOR_PHASE],
        maxUnitsPerCall: '1', price: resolveProviderPrice(prices.config, { provider: 'tikhub', route },
          billingUnit.defaultMultiplier, now) });
    } catch { return null; }
    if (canonical(approved) !== canonical(policy) || Date.parse(policy.toolPricing.validUntil) <= deadline.getTime()
      || decimal(policy.multiplier) > decimal(window.multiplier)) return null;
    policies.push(policy);
  }
  const draftId = await rpc(admin, 'bill2_create_draft', { p_actor_id: keys.actorId }, uuid);
  const input = { version: 'runtime.v1', network: 'deny', tools: [], sources: [],
    publishMonitor: { connectionId: keys.connectionId, refreshId: keys.refreshId } };
  const costUsd = policies.reduce((sum, policy) => sum + decimal(policy.upperUsd), 0n);
  const payload = { contractVersion: 'bill2.v2', mode: 'staging_test', testWindowId: window.id,
    scope: { kind: 'positioning_draft', draftId }, operation: 'research', modelId: READ_RUN_MODEL_ID,
    sourceHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), input, callPolicy: policies,
    rules: { version: 'runtime-staging-v1', quoteVersion: window.id, creditsPerUsd: window.creditsPerUsd,
      multiplier: window.multiplier, fx: {}, billingUnit },
    limits: { costUsd: usd(costUsd), credits: 0, maxPreDeduct: 0, maxCalls: policies.length * 2, deadline: deadline.toISOString() } };
  const run = await rpc(admin, 'bill2_prepare', { p_actor_id: keys.actorId,
    p_request_id: derivedUuid(`publish-monitor-read:${keys.connectionId}:${keys.refreshId}:${draftId}`), p_payload: payload },
  z.object({ id: uuid }).passthrough());
  const bound = await rpc(admin, 'publish_monitor_billed_run', { ...keyArgs(keys), p_run_id: run.id, p_policies: policies },
    runView.nullable());
  if (!bound?.runId) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
  // Another process bound a run first: this one was never used, close it at once.
  if (bound.runId !== run.id) { await closeRun(admin, keys.actorId, run.id, false); return null; }
  return { runId: run.id, policies };
}

const SCALE = 1_000_000_000_000n;
const usd = (value: bigint) => `${value / SCALE}.${(value % SCALE).toString().padStart(12, '0')}`;

/** Closes and finalizes a run (delivered when at least one answer was used, otherwise cancelled), then marks it closed. */
export async function closeRun(admin: Pick<SupabaseClient, 'rpc'>, actorId: string, runId: string, delivered: boolean) {
  const result = delivered ? { kind: 'usable_result', evidenceRef: `publish-monitor:${runId}`,
    evidenceHash: createHash('sha256').update(`publish-monitor:${runId}`).digest('hex') } : null;
  for (const [name, args] of [['bill2_close', { p_outcome: delivered ? 'delivered' : 'cancelled', p_result: result }],
    ['bill2_finalize', {}]] as const) {
    const done = await admin.rpc(name, { p_actor_id: actorId, p_run_id: runId, ...args });
    if (done.error) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
  }
  await rpc(admin, 'publish_monitor_billed_closed', { p_run_id: runId }, z.unknown());
}

/**
 * A run left open by a killed process, settled without a live claim (the connection, lease or account may be gone):
 * every call it sent without a receipt gets one — the saved receipt when the answer had been stored (the user pays
 * exactly what that answer cost, once; bill2_record ignores an identical replay), otherwise an unknown result (the user
 * pays nothing; the supplier cost is reconciled like any unknown tool result); every still-live attempt is freed; then
 * the run is closed and finalized.
 */
export async function settleLeftOpenRun(admin: Admin, keys: Pick<ClaimKeys, 'actorId'>, runId: string, rawPolicies: unknown[]) {
  const policies = z.array(frozenToolPolicy).parse(rawPolicies) as ToolCallPolicy[];
  const rows = await rpc(admin, 'publish_monitor_billed_recovery', { p_run_id: runId },
    z.array(z.object({ operationId: uuid, callId: uuid.nullable(), model: z.string(), callPending: z.boolean(), live: z.boolean(),
      receipt: z.record(z.string(), z.unknown()).nullable() }).strict()));
  const billing = toolSubcallBilling({ admin: admin as unknown as BillingRpc, actorId: keys.actorId, runId });
  let delivered = false;
  for (const row of rows) {
    if (row.callPending && row.callId) {
      if (row.receipt) {
        await billing.record(row.callId, row.receipt as ReturnType<typeof toolResultEvidence>);
        delivered ||= row.receipt.toolOutcome === 'delivered';
      } else {
        const policy = policies.find(candidate => candidate.model === row.model);
        if (!policy) throw new BilledReadError('PUBLISH_MONITOR_BILLING_UNAVAILABLE');
        const unknown: ResearchCallResult = { vendor: 'tikhub', route: policy.model.slice('tikhub:'.length), outcome: 'unknown',
          reason: 'PROCESS_INTERRUPTED', httpStatus: null, supplierMayCharge: true, usage: { unit: 'call', units: null }, items: [],
          truncated: false, fetchedAt: new Date().toISOString() };
        await billing.record(row.callId, toolResultEvidence(row.callId, policy, unknown,
          createHash('sha256').update(row.callId).digest('hex')));
      }
    }
    if (row.live) await rpc(admin, 'publish_monitor_billed_abandon', { p_run_id: runId, p_operation_id: row.operationId }, z.boolean());
  }
  await closeRun(admin, keys.actorId, runId, delivered);
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

export type BilledReadDeps = { admin: Admin; env: Env; now?: () => Date; vendors?: SubcallContext['vendors'];
  secrets?: SubcallContext['secrets']; rateCounter?: SubcallContext['rateCounter'] };

/**
 * Reads one claimed TikHub connection: stored answers of this refresh are re-used; anything else is one billed subcall
 * each on this refresh's run. The run is always closed and finalized before returning, so no hold stays frozen.
 */
export async function billedTikhubRead(deps: BilledReadDeps, keys: ClaimKeys, platform: SocialPlatform, account: string)
  : Promise<ReadOutcome> {
  const { admin } = deps;
  const requests = readRequests(platform, account);
  // A run left open by an earlier attempt of this refresh is settled first (its unanswered calls at zero).
  const open = await rpc(admin, 'publish_monitor_billed_run', { ...keyArgs(keys), p_run_id: null, p_policies: null }, runView.nullable());
  if (open === null) return { kind: 'stale' };
  if (open.runId) await settleLeftOpenRun(admin, keys, open.runId, open.policies ?? []);
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
  let admitted: Awaited<ReturnType<typeof admitReadRun>>;
  try { admitted = await admitReadRun(admin, keys, missing.map(item => item.request.route), deps.env, deps.now?.()); }
  catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 64) : 'ADMISSION_FAILED' }; }
  if (!admitted) return { kind: 'unavailable', reason: 'TIKHUB_NOT_ADMITTED' };
  let sequence = 0;
  let delivered = false;
  try {
    for (const item of missing) {
      const context: SubcallContext = { policies: admitted.policies, phase: PUBLISH_MONITOR_PHASE,
        billing: toolSubcallBilling({ admin: admin as unknown as BillingRpc, actorId: keys.actorId, runId: admitted.runId }),
        evidence: ledgerPort(admin, keys, requestIdentity(item.request), `tikhub:${item.request.route}`),
        nextSequence: () => ++sequence,
        secrets: deps.secrets ?? platformSecretReader(admin as unknown as BillingRpc, deps.env),
        rateCounter: deps.rateCounter ?? checkVendorRateLimit, newId: () => crypto.randomUUID(),
        ...(deps.vendors ? { vendors: deps.vendors } : {}), ...(deps.now ? { now: deps.now } : {}) };
      const outcome = await runSubcall(context, item.request);
      if (!outcome.sent) {
        if (outcome.stop === 'BALANCE_LOW') return { kind: 'insufficient_credits', results };
        return { kind: 'unavailable', reason: outcome.stop.slice(0, 64) };
      }
      results[item.kind] = outcome.result;
      delivered ||= outcome.result.outcome === 'ok' || outcome.result.outcome === 'partial';
    }
    return { kind: 'read', results, delivered };
  } finally {
    await closeRun(admin, keys.actorId, admitted.runId, delivered);
  }
}
