/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResearchTurnEvent } from '../../../shared/researchTurn';
import { decimal } from '../../bill2/decimal';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import { platformSecretReader, type SecretReader } from '../../research/runtime/secrets';
import { TURN_BILLING_RUN } from '../../research/runtime/store';
import type { SubcallContext, VendorCalls } from '../../research/runtime/subcall';
import type { ResearchToolContext } from '../../research/runtime/toolContext';
import { toolEnvelope } from '../../research/tools/envelope';
import type { ResearchToolName } from '../../research/tools/names';
import { callFirecrawl } from '../../research/vendors/firecrawl';
import { DEFAULT_TIMEOUT_MS } from '../../research/vendors/http';
import { callParallel } from '../../research/vendors/parallel';
import { callTikhub } from '../../research/vendors/tikhub';
import type { ResearchVendor } from '../../research/vendors/types';
import { admitResearchTurn, researchToolBytes } from '../../runtime/researchAdmission';
import { fastSearchOnly, researchRuntimeTools } from '../../runtime/researchRuntimeTool';
import { frozenResearchConfig, RESEARCH_RESULT_RESERVE_BYTES, type FrozenResearchTurn } from '../../runtime/researchTurn';
import type { RuntimeTool } from '../../runtime/runner';
import type { ConfigurationRows } from '../../runtime/settingsRows';
import { TurnStop } from '../call';
import { acquireSlot, type CounterStore } from '../limiter';
import { turnResearchStore, type PreparedResearch } from './benchmarkStore';
import { openToolRow, ToolLimitReached, type ToolRow } from './meter';
import { MAX_TOOL_DEFINITIONS, paidToolBounds, PRODUCTION } from './plan';
import { MIN_SUPPLIER_MS, SUPPLIER_SLOT_WAIT_MS, VENDOR_CONCURRENCY } from './suppliers';
import type { ToolCallDeps } from './types';

/*
 * CORE-PATH-V2 V2-5c (Owner 10-30 option A): the positioning benchmark tools on the turn core. The flow is the old code
 * (discovery.ts, benchmarkFetch.ts, researchRuntimeTool.ts) over a store that writes nothing until turn_close (benchmarkStore.ts).
 * One tool call (the old single research slot, one model continuation) settles in batches: a receipt row every BATCH subcalls, whose
 * raw body keeps the batch's operations, so a crash loses at most one batch of paid lookups and the next turn reuses the rest.
 * The keys are read on the first subcall, so a turn that makes none adds no round trip.
 */
const REQUIRED = ['propose_keywords', 'benchmark_discover', 'propose_more_candidates', 'benchmark_fetch'] as const;
/** No subcall, no row: the model continuation that reads their result is already one of the turn's M. */
const FREE: readonly string[] = ['propose_keywords', 'propose_more_candidates'];
/** A finished round is not searched again (its lookups were paid for): the model is pointed at its card instead. */
const ROUND_FINISHED = toolEnvelope({ status: 'ok', reason: 'ROUND_ALREADY_COMPLETED',
  nextStep: '这一轮已经搜完，候选卡已经给过用户。请用户在卡上确认；要更多候选用 propose_more_candidates，要换方向就提新的关键词。' });
const BATCH = 5, LOOKUP_MS = 30_000;
/** Rows of the one paid tool call: the largest configurable allowance (RUN_MAX_CALLS - 3 = 29) in batches. */
export const BENCHMARK_ROWS = 6;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export type MentorResearch = { research: FrozenResearchTurn; tools: ResearchToolName[]; policies: ToolCallPolicy[] };
export type BenchmarkDeps = { readKey?: SecretReader; vendors?: VendorCalls };

export async function planMentorResearch(input: { admin: SupabaseClient; configuration: Promise<ConfigurationRows>;
  modelCalls: number; modelMultiplier: string; now?: () => Date }): Promise<MentorResearch | null> {
  // Capacity needs the turn's text, read at turn_open: mentor.ts checks it there with benchmarkToolBytes.
  return admitResearchTurn({ admin: input.admin, real: PRODUCTION, configuration: input.configuration, modelCalls: input.modelCalls,
    offeredTools: 0, maxTools: MAX_TOOL_DEFINITIONS, defaultMultiplier: input.modelMultiplier, runMultiplier: input.modelMultiplier,
    deadline: new Date((input.now?.() ?? new Date()).getTime() + 3_600_000).toISOString(), fits: () => true,
    ...(input.now ? { now: input.now } : {}) });
}

/** Whether the turn has these tools (default: the whole benchmark flow). */
export const benchmarkReady = (research: MentorResearch | null, names: readonly ResearchToolName[] = REQUIRED) =>
  research !== null && names.every(name => research.tools.includes(name));

/** The definitions on the request plus one result and the reply after it. */
export const benchmarkToolBytes = (research: MentorResearch) => RESEARCH_RESULT_RESERVE_BYTES
  + researchToolBytes(research.tools, fastSearchOnly(frozenResearchConfig(research.research)));

/** The bounds the turn freezes: one per receipt row, each a whole batch at the highest route price. */
export const mentorResearchBounds = (research: MentorResearch, modelMultiplier: string): string[] =>
  paidToolBounds(research.policies, BENCHMARK_ROWS, BATCH * BENCHMARK_ROWS, modelMultiplier);
const highestMultiplier = (policies: readonly ToolCallPolicy[]) =>
  policies.reduce((max, p) => decimal(p.multiplier) > decimal(max) ? p.multiplier : max, policies[0]!.multiplier);

export type BenchmarkToolsInput = { research: MentorResearch; prepared: PreparedResearch; deps?: BenchmarkDeps; admin: SupabaseClient;
  slots: CounterStore; calls: ToolCallDeps; actorId: string; sessionId: string; requestId: string; text: string; deadline: number;
  emit: (event: ResearchTurnEvent) => void;
  /** The one-switch pause and the call limits for this call's subcalls; throws TurnStop to refuse. */
  callGate: (subcalls: number) => Promise<void>;
  onStop: (stop: TurnStop) => void };

const REAL_VENDORS: VendorCalls = { tikhub: callTikhub, parallel: callParallel, firecrawl: callFirecrawl };

export function turnBenchmarkTools(input: BenchmarkToolsInput) {
  const { research: { research, tools: names, policies } } = input;
  const scope = { userId: input.actorId, sessionId: input.sessionId, executionId: input.requestId };
  const turnStore = turnResearchStore({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, text: input.text,
    prepared: input.prepared });
  const { store } = turnStore;
  const left = () => input.deadline - Date.now();
  const multiplier = highestMultiplier(policies);
  const [rowUpper] = paidToolBounds(policies, BENCHMARK_ROWS, BATCH * BENCHMARK_ROWS, multiplier);
  let row: ToolRow | undefined, rows = 0, active = { name: '', args: '' }, vendor: ResearchVendor = 'tikhub';
  let release: (() => Promise<void>) | undefined, reported = 0;
  // Each receipt keeps the operations settled since the last one.
  const settle = async () => {
    if (!row) return;
    const open = row; row = undefined;
    const operations = turnStore.operations();
    await open.settle(operations.slice(reported));
    reported = operations.length;
  };
  const held = async <T>(send: () => Promise<T>) => { try { return await send(); } finally { await release?.(); release = undefined; } };
  const real = input.deps?.vendors ?? REAL_VENDORS;
  const vendors: VendorCalls = { tikhub: (...a) => held(() => real.tikhub(...a)), parallel: (...a) => held(() => real.parallel(...a)),
    firecrawl: (...a) => held(() => real.firecrawl(...a)) };
  const readKey = input.deps?.readKey ?? platformSecretReader(input.admin);
  const keys = new Map<ResearchVendor, Promise<string | null>>();
  const subcall: SubcallContext = {
    policies, evidence: store.evidence(), phase: research.phase, vendors,
    secrets: name => { const key = keys.get(name) ?? readKey(name); keys.set(name, key); return key; },
    // The in-flight slot below is the supplier limit of this path (suppliers.ts).
    rateCounter: async () => true,
    nextSequence: () => 0,
    newId: () => { throw new Error('RESEARCH_OPERATION_ID_REQUIRED'); },
    billing: { runId: TURN_BILLING_RUN,
      // begin before anything is sent (2.5.2): the row of this batch opens with its first subcall.
      async claim() {
        if (!row) {
          row = await openToolRow(input.calls, { toolName: active.name, requestHash: sha256(`${active.args}:${++rows}`), upperUsd: rowUpper!, multiplier });
        }
        return { state: 'claimed', callId: randomUUID(), token: randomUUID() };
      },
      dispatch: async () => true,
      async record() {
        if (row && row.receipts.length >= BATCH) await settle();
        return { accountClosed: false, contentDeleted: false };
      } },
    timeoutMs: () => Math.min(DEFAULT_TIMEOUT_MS, Math.floor(left())),
    // A supplier slot, taken last: with none (or no time) nothing is sent and the subcall is free.
    beforeSend: async () => {
      if (left() < MIN_SUPPLIER_MS) return false;
      try { release = await acquireSlot(input.slots, `vendor:${vendor}`, { limit: VENDOR_CONCURRENCY[vendor], waitMs: SUPPLIER_SLOT_WAIT_MS }); }
      catch { return false; }
      return true;
    },
    onResult: (result, evidence) => {
      const policy = policies.find(p => p.provider === result.vendor && p.model === `${result.vendor}:${result.route}`);
      row?.add({ result, costUsd: evidence.toolOutcome === 'unknown' ? null : evidence.cost, multiplier: policy?.multiplier ?? '1' });
    },
  };
  const ctx: ResearchToolContext = { scope, executionId: input.requestId, config: frozenResearchConfig(research), store, subcall,
    emit: event => { if (event.type === 'research_call') vendor = event.dataKind === 'web_search' ? 'parallel'
      : event.dataKind === 'web_fetch' ? 'firecrawl' : 'tikhub'; input.emit(event); },
    now: () => new Date(), lookupTime: () => left() >= MIN_SUPPLIER_MS + LOOKUP_MS };
  let used = false;
  const tools: RuntimeTool[] = researchRuntimeTools(ctx, names).map(tool => ({ ...tool, async execute(args, callId) {
    if (used) return toolEnvelope({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
    used = true;
    try {
      if (tool.name === 'benchmark_discover' && turnStore.finishedRound(args)) return ROUND_FINISHED;
      if (FREE.includes(tool.name)) return await tool.execute(args, callId);
      await input.callGate(research.subcalls);
      active = { name: tool.name, args: JSON.stringify({ name: tool.name, args }) };
      try { return await tool.execute(args, callId); }
      finally { await settle(); }
    } catch (error) {
      if (error instanceof TurnStop) { input.onStop(error); throw error; }
      if (error instanceof ToolLimitReached) return toolEnvelope({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
      return toolEnvelope({ status: 'unavailable', reason: 'RESEARCH_STATE_UNAVAILABLE' });
    }
  } }));
  return { tools, journal: turnStore.journal };
}
