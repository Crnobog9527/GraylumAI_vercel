/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { swallow } from '../../../lib/swallow';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimal, DECIMAL_SCALE } from '../../bill2/decimal';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import type { SecretReader } from '../../research/runtime/secrets';
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { frozenResearchConfig, FREE_CHAT_RESEARCH_CALLS, RESEARCH_RESULT_RESERVE_BYTES } from '../../runtime/researchTurn';
import { admitResearchTurn } from '../../runtime/researchAdmission';
import type { ResearchRejectionReason } from '../../runtime/researchAdmissionDiagnostics';
import { chatResearchEnabled } from '../../runtime/freeChatResearch';
import type { ConfigurationRows } from '../../runtime/settingsRows';
import type { StagingPolicy } from '../../runtime/stagingPolicy';
import type { ResearchToolsConfig } from '../../research/vendors/config';
import type { ResearchVendor } from '../../research/vendors/types';
import type { GeneralResearchToolName, ToolPlan, TrimReason, TurnToolName } from './types';

/*
 * CORE-PATH-V2 V2-6, 2.5.3 / 2.7 / 2.9 rule 2: what a turn's tools may do, decided before turn_open from the catalog cache.
 * The session kind fixes the offered definitions; this turn may use fewer of them (switch off, no priced route, an empty key
 * slot, or an input budget that cannot hold one tool result next to the required context). A trimmed tool keeps its
 * definition; the turn's current message says it is unavailable and the opened event names it with its reason, and its
 * limits are 0 so the turn freezes nothing for it.
 */
/** load_skill per turn and read_source per turn (the existing per-reply limits). */
export const LOAD_SKILL_CALLS = 2;
export const READ_SOURCE_CALLS = 2;
/** Research-only turns may use this input ceiling (Owner 10-17, raised to 150000 on 10-27). */
export const RESEARCH_INPUT_BYTES = 150_000;
/** Request bytes kept for a library read or a loaded Skill and the reply after it. */
export const FREE_RESULT_RESERVE_BYTES = 24_576;
const MAX_TOOL_DEFINITIONS = 9;
/** Production policy marker: the 2.8 path has no test window; routes are approved by research and price settings. */
const PRODUCTION = { mode: 'production' } as unknown as StagingPolicy;

export type ResearchSetup = { config: ResearchToolsConfig; policies: ToolCallPolicy[]; keys: Partial<Record<ResearchVendor, string>> };

export type PlanInput = {
  admin: SupabaseClient; configuration: Promise<ConfigurationRows>;
  /** The session kind's tool whitelist, in offer order (2.9 rule 2: the same on every turn of the session). */
  offered: readonly TurnToolName[];
  /** Whether a free tool has anything to serve this turn (a Skill catalog, a readable library); absent: yes. */
  freeReady?: Partial<Record<'read_source' | 'load_skill', boolean>>;
  /** Bytes the turn needs without any tool result (instructions, current message, tool definitions), and its input ceiling. */
  requiredBytes: number; inputBytes: number;
  /** The ceiling a turn with usable research may use (absent: inputBytes). */
  researchInputBytes?: number;
  /** The turn's model multiplier, the billing unit's default multiplier. */
  modelMultiplier: string; defaultMultiplier: string;
  /** Supplier keys, read fresh (OR-1). */
  readKey: SecretReader; now?: () => Date;
};

const REASONS: Partial<Record<ResearchRejectionReason, TrimReason>> = {
  CONFIG_DISABLED: 'disabled', CONFIG_MISSING: 'disabled', CONTEXT_CAPACITY: 'capacity', CALL_LIMIT: 'limit', TOOL_LIMIT: 'limit',
};
const formatUsd = (value: bigint) => {
  const whole = value / DECIMAL_SCALE, fraction = (value % DECIMAL_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};

/**
 * The paid-tool bounds for turnPolicy: `calls` entries whose sum covers `subcalls` subcalls at the highest route price.
 * turnPolicy prices tools with the model's m, so a route m above it scales the bound up (never under-frozen); the USD
 * stop-loss reservation is then at least the real bound too.
 */
export function paidToolBounds(policies: readonly ToolCallPolicy[], calls: number, subcalls: number, modelMultiplier: string): string[] {
  if (calls <= 0 || !policies.length) return [];
  const upper = policies.reduce((max, p) => decimal(p.upperUsd) > max ? decimal(p.upperUsd) : max, 0n);
  const m = policies.reduce((max, p) => decimal(p.multiplier) > max ? decimal(p.multiplier) : max, 0n);
  const model = decimal(modelMultiplier);
  const total = upper * BigInt(subcalls) * (m > model ? m : model);
  const scaled = (total + model - 1n) / model;
  // Split evenly, rounding the first entry up, so the entries sum to at least the total.
  const share = scaled / BigInt(calls), first = scaled - share * BigInt(calls - 1);
  return Array.from({ length: calls }, (_, i) => formatUsd(i === 0 ? first : share));
}

export async function planTurnTools(input: PlanInput): Promise<{ plan: ToolPlan; research: ResearchSetup | null }> {
  const offered = [...input.offered];
  const trimmed: ToolPlan['trimmed'] = [];
  const available: TurnToolName[] = [];
  const trim = (name: TurnToolName, reason: TrimReason) => trimmed.push({ name, reason });
  if (offered.length > MAX_TOOL_DEFINITIONS) throw new Error('TURN_TOOLS_INVALID');
  let used = input.requiredBytes;
  const fits = (extra: number) => used + extra <= input.inputBytes;

  // Free tools first: they cost the user nothing and serve the user's own material.
  let freeTools = 0;
  for (const name of ['read_source', 'load_skill'] as const) {
    if (!offered.includes(name)) continue;
    if (input.freeReady?.[name] === false) { trim(name, 'disabled'); continue; }
    if (!fits(FREE_RESULT_RESERVE_BYTES)) { trim(name, 'capacity'); continue; }
    available.push(name);
    freeTools += name === 'load_skill' ? LOAD_SKILL_CALLS : READ_SOURCE_CALLS;
  }
  if (available.some(name => name === 'read_source' || name === 'load_skill')) used += FREE_RESULT_RESERVE_BYTES;
  // read_skill_file reads the turn's frozen Skill package from the process cache: no row, no model call of its own (2.5.3).
  if (offered.includes('read_skill_file')) available.push('read_skill_file');

  const research = offered.filter((name): name is GeneralResearchToolName => (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name));
  let setup: ResearchSetup | null = null, paidTools = 0, subcalls = 0;
  if (research.length) {
    let rejected: TrimReason = 'no_route';
    const admitted = await chatResearchEnabled(input.admin, input.configuration)
      ? await admitResearchTurn({ admin: input.admin, real: PRODUCTION, general: true, configuration: input.configuration,
        modelCalls: 1 + freeTools, extraModelCalls: FREE_CHAT_RESEARCH_CALLS, offeredTools: 0, maxTools: MAX_TOOL_DEFINITIONS,
        defaultMultiplier: input.defaultMultiplier, runMultiplier: input.modelMultiplier,
        // Prices must outlive the turn (maxDuration 300 s), with margin.
        deadline: new Date((input.now?.() ?? new Date()).getTime() + 3_600_000).toISOString(),
        // The definitions are on the request whatever happens (2.9 rule 2), so only the result reserve must fit.
        fits: () => used + RESEARCH_RESULT_RESERVE_BYTES <= (input.researchInputBytes ?? input.inputBytes), ...(input.now ? { now: input.now } : {}),
        onRejected: rejection => { rejected = REASONS[rejection.reason] ?? 'no_route'; } })
      : (rejected = 'disabled', null);
    if (admitted) {
      const config = frozenResearchConfig(admitted.research);
      const keys: ResearchSetup['keys'] = {};
      for (const vendor of admitted.research.vendors) {
        // An unreadable key store trims the tools like an empty slot: the turn goes on without them.
        const key = await swallow('turn_tools_vendor_key_unavailable', input.readKey(vendor), null, { vendor });
        if (key) keys[vendor] = key;
      }
      const usable = (name: GeneralResearchToolName) => admitted.tools.includes(name) && config.routes.some(route =>
        keys[route.vendor] && (name === 'web_search' ? route.kind === 'web_search' || route.kind === 'web_search_pro'
          : name === 'web_fetch' ? route.kind === 'web_fetch' : route.platform !== 'web'));
      for (const name of research) {
        if (usable(name)) available.push(name);
        else trim(name, admitted.tools.includes(name) ? 'no_key' : 'no_route');
      }
      if (research.some(usable)) {
        paidTools = FREE_CHAT_RESEARCH_CALLS;
        subcalls = admitted.research.subcalls;
        setup = { config, policies: admitted.policies.filter(policy => keys[policy.provider]), keys };
        used += RESEARCH_RESULT_RESERVE_BYTES;
      }
    } else for (const name of research) trim(name, rejected);
  }
  const order = (names: TurnToolName[]) => offered.filter(name => names.includes(name));
  const note = trimmed.length ? `\nTools unavailable for this reply: ${trimmed.map(t => `${t.name} (${t.reason})`).join(', ')}. `
    + 'Do not call them; if the answer needs them, tell the user plainly.' : null;
  return {
    plan: { offered, available: order(available), trimmed, note,
      paidToolUpperUsd: setup ? paidToolBounds(setup.policies, paidTools, subcalls, input.modelMultiplier) : [],
      limits: { paidTools: setup ? paidTools : 0, freeTools }, subcalls, reserveBytes: used - input.requiredBytes },
    research: setup,
  };
}
