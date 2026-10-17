/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-3: the research part of a frozen positioning mentor context (admission writes it,
// execution reads it back). Kept apart from researchAdmission.ts so the context schema loads no admission code.
import { z } from 'zod';
import { RUN_MAX_CALLS, type ResearchToolsConfig } from '../research/vendors/config';
import { RESEARCH_VENDORS, SOCIAL_KINDS, SOCIAL_PLATFORMS } from '../research/vendors/types';

export const RESEARCH_TURN_VERSION = 'research-turn-v1';
/** BILL2 purpose of a research subcall: its start threshold and frozen price list this phase. */
export const RESEARCH_PHASE = 'research';
/** One tool result (TOOL_RESULT_MAX_BYTES 20000) plus its call arguments and framing, kept free for the reply after it. */
export const RESEARCH_RESULT_RESERVE_BYTES = 24576;
/** Account namespace of locally priced tool routes; staging windows name their own. */
export const LOCAL_RESEARCH_ACCOUNT = 'research-local';
/** RUNTIME-PROD: production has no window; its routes are approved by the research and price settings (SQL 0292). */
export const PRODUCTION_RESEARCH_ACCOUNT = 'research-production';

const route = z.object({
  platform: z.enum([...SOCIAL_PLATFORMS, 'web']),
  kind: z.enum([...SOCIAL_KINDS, 'web_search', 'web_search_pro', 'web_fetch']),
  vendor: z.enum(RESEARCH_VENDORS), route: z.string().min(1).max(120), backup: z.null(), maxUnitsPerCall: z.literal('1'),
}).strict();
/**
 * The research part of a frozen mentor context. Only priced routes are kept, so a tool never reaches a route whose
 * price the run did not freeze. Admin attestations stay in settings: an enabled vendor was attested when admitted.
 */
export const frozenResearchTurn = z.object({
  version: z.literal(RESEARCH_TURN_VERSION),
  configRevision: z.number().int().min(0),
  phase: z.literal(RESEARCH_PHASE),
  subcalls: z.number().int().min(1).max(RUN_MAX_CALLS - 1),
  reserve: z.literal(RESEARCH_RESULT_RESERVE_BYTES),
  vendors: z.array(z.enum(RESEARCH_VENDORS)).min(1).max(RESEARCH_VENDORS.length),
  verifiedPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
  benchmarkPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
  routes: z.array(route).min(1).max(64),
  discoverSubcalls: z.number().int().min(1).max(RUN_MAX_CALLS - 1),
  recentGrowth: z.object({
    maxFirstPostAgeDays: z.number().int().min(1).max(365),
    minViewsToFollowers: z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,4})?$/),
  }).strict(),
}).strict();
export type FrozenResearchTurn = z.infer<typeof frozenResearchTurn>;

/** The tool configuration an execution runs with: exactly the frozen routes, switches and limits. */
export function frozenResearchConfig(research: FrozenResearchTurn): ResearchToolsConfig {
  const vendor = (name: typeof RESEARCH_VENDORS[number]) => ({ enabled: research.vendors.includes(name), hardCapAttested: null });
  return {
    version: 1, enabled: true,
    vendors: { tikhub: vendor('tikhub'), parallel: vendor('parallel'), firecrawl: vendor('firecrawl') },
    verifiedPlatforms: [...research.verifiedPlatforms], benchmarkPlatforms: [...research.benchmarkPlatforms],
    routes: research.routes.map(entry => ({ ...entry })),
    limits: { maxSubcallsPerRound: research.subcalls, discoverSubcalls: Math.min(research.discoverSubcalls, research.subcalls) },
    recentGrowth: { ...research.recentGrowth },
  };
}
