/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Research tool names only (plan §2.1). No imports: the Agent tool allowlist and the AC-0 probe's fixed module graph load it.
export const RESEARCH_TOOL_NAMES = [
  'propose_keywords', 'benchmark_discover', 'social_search', 'propose_more_candidates',
  'benchmark_fetch', 'social_account', 'web_search', 'web_fetch',
] as const;
export type ResearchToolName = typeof RESEARCH_TOOL_NAMES[number];

/** Per-Skill exposure (plan §2.1): the positioning Skill runs the benchmark flow, everything else the general lookups. */
export const POSITIONING_RESEARCH_TOOLS: readonly ResearchToolName[] = Object.freeze([
  'propose_keywords', 'benchmark_discover', 'propose_more_candidates', 'benchmark_fetch', 'web_search', 'web_fetch',
]);
export const GENERAL_RESEARCH_TOOLS: readonly ResearchToolName[] = Object.freeze([
  'social_search', 'social_account', 'web_search', 'web_fetch',
]);
