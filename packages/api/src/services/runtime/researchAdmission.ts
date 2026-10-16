/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-3 (plan §1.2, §2.1, §2.5, §3.1, §5): which research tools a positioning mentor turn gets,
// decided once at admission and frozen with the run. With the admin switch off, or nothing priced, the request
// carries no research tool at all. Every offered route has a current price frozen into the run (0255 checks each
// claim against it), a start threshold for this phase, and on staging the same entry in the test window.
// The run's call ceiling counts the extra model call that reads a tool result plus every supplier subcall.
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readProviderPrices, resolveProviderPrice } from '../billingProviderPrices';
import { decimal } from '../bill2/decimal';
import { toolCallPolicy, type ToolCallPolicy } from '../bill2/toolBilling';
import { BENCHMARK_ROUTE_KINDS, readResearchToolsConfig, RUN_MAX_CALLS, type ResearchToolsConfig } from '../research/vendors/config';
import { POSITIONING_RESEARCH_TOOLS, type ResearchToolName } from '../research/tools/schemas';
import { RESEARCH_VENDORS, type SocialPlatform } from '../research/vendors/types';
import type { FrozenPaygRun } from '../bill2/service';
import { freezePaygMessageBudget } from './paygMessageBudget';
import { fastSearchOnly, researchToolDescription, researchToolParameters } from './researchRuntimeTool';
import type { StagingPolicy } from './stagingPolicy';
import { frozenResearchTurn, LOCAL_RESEARCH_ACCOUNT, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TURN_VERSION,
  type FrozenResearchTurn } from './researchTurn';

/** Serialized tool definitions as the SDK sends them; the full request is checked again before dispatch. */
export function researchToolBytes(names: readonly ResearchToolName[], fastOnly = false): number {
  return Buffer.byteLength(JSON.stringify(names.map(name => ({ type: 'function', function: { name,
    description: researchToolDescription(name), strict: true,
    parameters: z.toJSONSchema(researchToolParameters(name, fastOnly)) } }))));
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface ResearchAdmissionInput {
  admin: SupabaseClient;
  real?: StagingPolicy;
  /** Model calls the run already allows, before the one that reads a tool result. */
  modelCalls: number;
  /** Tool definitions already offered and the profile's ceiling per request. */
  offeredTools: number;
  maxTools: number;
  defaultMultiplier: string;
  runMultiplier: string;
  /** Frozen prices must outlive the run. */
  deadline: string;
  /** Whether the required context still fits with these extra tool bytes plus the result reserve. */
  fits: (extraBytes: number) => boolean;
  now?: () => Date;
}

export interface ResearchAdmission { research: FrozenResearchTurn; tools: ResearchToolName[]; policies: ToolCallPolicy[] }

async function thresholdKeys(admin: SupabaseClient): Promise<Set<string> | null> {
  const row = await admin.from('system_settings').select('value').eq('key', 'billing_payg_start_thresholds').maybeSingle();
  if (row.error || !row.data) return null;
  const parsed = z.object({ thresholds: z.array(z.object({ model: z.string(), purpose: z.string() }).passthrough()) }).passthrough()
    .safeParse(typeof row.data.value === 'string' ? JSON.parse(row.data.value) : row.data.value);
  if (!parsed.success) return null;
  const counts = new Map<string, number>();
  for (const entry of parsed.data.thresholds) counts.set(`${entry.model}\n${entry.purpose}`, (counts.get(`${entry.model}\n${entry.purpose}`) ?? 0) + 1);
  // The claim needs exactly one entry per route and purpose (0180).
  return new Set([...counts].filter(([, count]) => count === 1).map(([key]) => key));
}

/** null = this turn offers no research tool (switch off, nothing priced, or no room); never an admission failure. */
export async function admitResearchTurn(input: ResearchAdmissionInput): Promise<ResearchAdmission | null> {
  const state = await readResearchToolsConfig(input.admin);
  const config = state.config;
  if (!config.enabled) return null;
  const subcalls = Math.min(config.limits.maxSubcallsPerRound, RUN_MAX_CALLS - input.modelCalls - 1);
  const room = input.maxTools - input.offeredTools;
  if (subcalls < 1 || room < 1) return null;
  const now = input.now?.() ?? new Date();
  let prices: Awaited<ReturnType<typeof readProviderPrices>>;
  let thresholds: Set<string> | null;
  try { [prices, thresholds] = await Promise.all([readProviderPrices(input.admin), thresholdKeys(input.admin)]); }
  catch { return null; }
  if (!thresholds) return null;
  const priced = new Map<string, { entry: ResearchToolsConfig['routes'][number]; policy: ToolCallPolicy }>();
  for (const entry of config.routes) {
    if (!config.vendors[entry.vendor].enabled) continue;
    if (entry.platform !== 'web' && !config.verifiedPlatforms.includes(entry.platform)) continue;
    const model = `${entry.vendor}:${entry.route}`;
    const windowEntry = input.real?.toolPolicies?.find(policy => policy.model === model);
    if (input.real && !windowEntry) continue;
    let policy: ToolCallPolicy;
    try {
      policy = toolCallPolicy({ vendor: entry.vendor, account: windowEntry?.account ?? LOCAL_RESEARCH_ACCOUNT, route: entry.route,
        purposes: [RESEARCH_PHASE], maxUnitsPerCall: entry.maxUnitsPerCall,
        price: resolveProviderPrice(prices.config, { provider: entry.vendor, route: entry.route }, input.defaultMultiplier, now) });
    } catch { continue; }
    // Staging: the window must approve exactly this frozen price (runtime_test_window_allowed compares entries).
    if (windowEntry && canonical(windowEntry) !== canonical(policy)) continue;
    if (Date.parse(policy.toolPricing.validUntil) <= Date.parse(input.deadline)) continue;
    if (decimal(policy.multiplier) > decimal(input.runMultiplier)) continue;
    if (!thresholds.has(`${model}\n${RESEARCH_PHASE}`)) continue;
    priced.set(`${entry.platform}:${entry.kind}`, { entry, policy });
  }
  const has = (platform: SocialPlatform | 'web', kind: string) => priced.has(`${platform}:${kind}`);
  const fetchable = config.benchmarkPlatforms.filter(platform =>
    BENCHMARK_ROUTE_KINDS[platform]?.verified && BENCHMARK_ROUTE_KINDS[platform]!.kinds.every(kind => has(platform, kind)));
  const discoverable = fetchable.filter(platform => has(platform, 'keyword_posts'));
  const offered = new Set<ResearchToolName>([
    ...(discoverable.length ? ['propose_keywords', 'benchmark_discover', 'propose_more_candidates'] as const : []),
    ...(fetchable.length ? ['benchmark_fetch'] as const : []),
    ...(has('web', 'web_search') ? ['web_search'] as const : []),
    ...(has('web', 'web_fetch') ? ['web_fetch'] as const : []),
  ]);
  const tools = POSITIONING_RESEARCH_TOOLS.filter(name => offered.has(name));
  // All or nothing: a partial benchmark tool set could not finish its flow.
  if (!tools.length || tools.length > room) return null;
  const fastOnly = fastSearchOnly({ routes: [...priced.values()].map(({ entry }) => entry) });
  if (!input.fits(researchToolBytes(tools, fastOnly) + RESEARCH_RESULT_RESERVE_BYTES)) return null;
  const used = [...priced.values()].filter(({ entry }) => entry.platform === 'web'
    ? (entry.kind === 'web_fetch' ? offered.has('web_fetch') : offered.has('web_search'))
    : fetchable.includes(entry.platform) && (BENCHMARK_ROUTE_KINDS[entry.platform]!.kinds.includes(entry.kind as never)
      || entry.kind === 'keyword_posts' && discoverable.includes(entry.platform)));
  const research = frozenResearchTurn.parse({
    version: RESEARCH_TURN_VERSION, configRevision: state.revision, phase: RESEARCH_PHASE, subcalls,
    reserve: RESEARCH_RESULT_RESERVE_BYTES,
    vendors: RESEARCH_VENDORS.filter(name => used.some(({ entry }) => entry.vendor === name)),
    verifiedPlatforms: config.verifiedPlatforms.filter(platform => used.some(({ entry }) => entry.platform === platform)),
    benchmarkPlatforms: fetchable, routes: used.map(({ entry }) => entry),
    discoverSubcalls: Math.min(config.limits.discoverSubcalls, subcalls), recentGrowth: config.recentGrowth,
  });
  return { research, tools, policies: used.map(({ policy }) => policy) };
}

/** true when the check passes, false when only the required context does not fit; other errors propagate. */
export function fitsCapacity(check: () => void): boolean {
  try { check(); return true; }
  catch (error) {
    if (error instanceof Error && error.message === 'RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY') return false;
    throw error;
  }
}

const SCALE = 1_000_000_000_000n;
const usd = (value: bigint) => `${value / SCALE}.${(value % SCALE).toString().padStart(12, '0')}`;

type MentorContext = Parameters<typeof freezePaygMessageBudget>[0] & { tools: string[]; research?: FrozenResearchTurn };

/**
 * Adds the admitted research tools to a positioning mentor turn's frozen context and v2 run: one more model call
 * to read a tool result, the subcall allowance, and the frozen tool prices. false = nothing changes.
 */
export async function attachResearchTurn(input: Omit<ResearchAdmissionInput, 'modelCalls' | 'offeredTools' | 'maxTools'
  | 'defaultMultiplier' | 'runMultiplier' | 'deadline'> & { context: MentorContext; billing: FrozenPaygRun }): Promise<boolean> {
  const { context, billing } = input;
  const primary = billing.callPolicy.find(policy => policy.modelId === context.modelId);
  if (!primary?.payg || !billing.rules.billingUnit) return false;
  // One more serial tool round must still fit the profile's message budget (freezePaygMessageBudget).
  if (2 + 4 * Math.min(context.maxToolCalls + 1, context.maxTurns) > primary.payg.maxMessages) return false;
  const admitted = await admitResearchTurn({ ...input, modelCalls: billing.limits.maxCalls, offeredTools: context.tools.length,
    maxTools: primary.payg.maxTools, defaultMultiplier: billing.rules.billingUnit.defaultMultiplier,
    runMultiplier: billing.rules.multiplier, deadline: billing.limits.deadline });
  if (!admitted) return false;
  context.tools.push(...admitted.tools);
  context.maxTurns += 1;
  context.maxToolCalls += 1;
  context.research = admitted.research;
  freezePaygMessageBudget(context, billing.callPolicy);
  const toolUpper = admitted.policies.reduce((upper, policy) => decimal(policy.upperUsd) > upper ? decimal(policy.upperUsd) : upper, 0n);
  billing.limits.costUsd = usd(decimal(billing.limits.costUsd) + decimal(primary.upperUsd) + toolUpper * BigInt(admitted.research.subcalls));
  billing.limits.maxCalls += 1 + admitted.research.subcalls;
  // The run stores tool prices beside its models (0255); TS readers split them with modelCallPolicies/toolCallPolicies.
  (billing.callPolicy as unknown[]).push(...admitted.policies);
  return true;
}
