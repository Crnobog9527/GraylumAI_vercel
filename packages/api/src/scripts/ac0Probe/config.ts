/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {z} from 'zod';

export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One measured combination. There is deliberately no field that can change
 * data_collection, fallbacks or parameter enforcement: routing() fixes them. */
export const probeConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  model: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/i).refine(model => !model.startsWith('openrouter/')),
  route: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/),
  effort: z.enum(efforts),
  /** USD per million tokens, sent as OpenRouter max_price. The provider refuses
   * a route priced above it, so the local per-call upper bound stays valid. */
  maxPrice: z.object({prompt: z.number().positive().max(100), completion: z.number().positive().max(100)}).strict(),
}).strict();
export type ProbeConfig = z.infer<typeof probeConfig>;

// Public OpenRouter catalog, read 2026-09-28 without a key (no model call).
// Listed USD per million tokens (prompt / completion):
//   qwen/qwen3.8-27b             DeepInfra 0.15 / 1.875, Alibaba 0.425 / 2.55
//   deepseek/deepseek-v4.1-flash DeepInfra 0.14 / 0.42, DeepSeek 0.15-0.30 / 0.60-1.20 (time of day)
// Reasoning levels: qwen xhigh / medium / low; deepseek max / high / low. Neither
// lists "none"; the current real path sends none for qwen (reasoningPolicy.ts).
// max_price below is about twice the highest listed price to absorb small changes.
const qwen = 'qwen/qwen3.8-27b';
const deepseek = 'deepseek/deepseek-v4.1-flash';
const qwenDeepInfra = {prompt: 0.3, completion: 3.75};
const qwenAlibaba = {prompt: 0.85, completion: 5.1};
const deepseekDeepInfra = {prompt: 0.3, completion: 0.9};
const deepseekOfficial = {prompt: 0.6, completion: 2.4};

export const builtInConfigs: readonly ProbeConfig[] = Object.freeze([
  {id: 'qwen-deepinfra-none', model: qwen, route: 'deepinfra', effort: 'none', maxPrice: qwenDeepInfra},
  {id: 'qwen-deepinfra-low', model: qwen, route: 'deepinfra', effort: 'low', maxPrice: qwenDeepInfra},
  {id: 'qwen-alibaba-none', model: qwen, route: 'alibaba', effort: 'none', maxPrice: qwenAlibaba},
  {id: 'qwen-alibaba-low', model: qwen, route: 'alibaba', effort: 'low', maxPrice: qwenAlibaba},
  {id: 'deepseek-deepinfra-none', model: deepseek, route: 'deepinfra', effort: 'none', maxPrice: deepseekDeepInfra},
  {id: 'deepseek-deepinfra-low', model: deepseek, route: 'deepinfra', effort: 'low', maxPrice: deepseekDeepInfra},
  {id: 'deepseek-official-none', model: deepseek, route: 'deepseek', effort: 'none', maxPrice: deepseekOfficial},
  {id: 'deepseek-official-low', model: deepseek, route: 'deepseek', effort: 'low', maxPrice: deepseekOfficial},
] satisfies ProbeConfig[]);

export const DEFAULT_CONFIG_IDS = ['qwen-deepinfra-none', 'qwen-deepinfra-low'];

/** OpenRouter provider routing for every probe call. Mirrors the real path
 * (openRouterPolicy.ts: one route, no fallbacks, parameters required) and adds
 * data_collection deny, which the real path does not send yet (RUNTIME-PROD). */
export function routing(config: ProbeConfig) {
  return {
    only: [config.route],
    allow_fallbacks: false as const,
    require_parameters: true as const,
    data_collection: 'deny' as const,
    max_price: {prompt: config.maxPrice.prompt, completion: config.maxPrice.completion},
  };
}

export function resolveConfigs(ids: string[], extra: unknown): ProbeConfig[] {
  const registry = new Map<string, ProbeConfig>(builtInConfigs.map(config => [config.id, config]));
  if (extra !== undefined) {
    for (const config of z.array(probeConfig).max(32).parse(extra)) registry.set(config.id, config);
  }
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('PROBE_CONFIG_INVALID: list each config once');
  return ids.map(id => {
    const config = registry.get(id);
    if (!config) throw new Error('PROBE_CONFIG_UNKNOWN: ' + id + '; known: ' + [...registry.keys()].join(', '));
    return probeConfig.parse(config);
  });
}

/** Chat templates add wrapper tokens around messages and tool schemas. */
const TEMPLATE_TOKEN_MARGIN = 2048;

/** Worst-case USD for one request: every body byte as a prompt token (byte-level
 * tokenizers never produce more tokens than bytes) plus a template margin, and
 * the full output allowance, both at max_price. Actual cost replaces it later. */
export function callBoundUsd(config: ProbeConfig, promptBytes: number, maxTokens: number): number {
  const promptTokens = promptBytes + TEMPLATE_TOKEN_MARGIN;
  return (promptTokens * config.maxPrice.prompt + maxTokens * config.maxPrice.completion) / 1_000_000;
}
