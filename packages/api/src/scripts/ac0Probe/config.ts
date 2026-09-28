/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {z} from 'zod';

export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** OpenRouter's reasoning object (docs: reasoning tokens). Only the shapes the
 * probe uses: off, a thinking token budget, or an effort level. */
export const reasoningObject = z.union([
  z.object({enabled: z.literal(false)}).strict(),
  z.object({max_tokens: z.number().int().min(1).max(32_768)}).strict(),
  z.object({effort: z.enum(efforts)}).strict(),
]);
export type ReasoningObject = z.infer<typeof reasoningObject>;

/** One measured combination. There is deliberately no field that can change
 * fallbacks or parameter enforcement: routing() fixes them. Thinking is set by
 * exactly one of effort (sent as reasoning_effort) or reasoning (sent as the
 * reasoning object); the transport refuses a body that differs from it. */
export const probeConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  model: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/i).refine(model => !model.startsWith('openrouter/')),
  route: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/),
  effort: z.enum(efforts).optional(),
  reasoning: reasoningObject.optional(),
  /** USD per million tokens, sent as OpenRouter max_price. The provider refuses
   * a route priced above it, so the local per-call upper bound stays valid. */
  maxPrice: z.object({prompt: z.number().positive().max(100), completion: z.number().positive().max(100)}).strict(),
  /** 'omit' sends no data_collection field; absent means deny. Only built-in
   * configs may set it (resolveConfigs refuses it from --config-file). */
  dataCollection: z.literal('omit').optional(),
}).strict().refine(config => (config.effort === undefined) !== (config.reasoning === undefined),
  {message: 'set exactly one of effort or reasoning'});
export type ProbeConfig = z.infer<typeof probeConfig>;

/** How a config controls thinking, as the request carries it. Field names and values only. */
export function thinkingLabel(config: ProbeConfig): string {
  return config.reasoning ? 'reasoning=' + JSON.stringify(config.reasoning) : 'reasoning_effort=' + config.effort;
}

// Public OpenRouter catalog, read 2026-09-28 without a key (no model call).
// Listed USD per million tokens (prompt / completion):
//   qwen/qwen3.8-27b             DeepInfra 0.15 / 1.875, Alibaba 0.425 / 2.55
//   deepseek/deepseek-v4.1-flash DeepInfra 0.14 / 0.42, DeepSeek 0.15-0.30 / 0.60-1.20 (time of day)
//   qwen/qwen3.8-flash           Alibaba only, 0.15 / 0.47
// Reasoning levels: qwen xhigh / medium / low; deepseek max / high / low. Neither
// lists "none"; the current real path sends none for qwen (reasoningPolicy.ts).
// qwen3.8-flash lists no effort levels and its Alibaba route does not declare
// reasoning_effort; it declares the reasoning object, thinking is on by default and
// supports_max_tokens (a thinking budget, Alibaba thinking_budget 1-32768).
// max_price below is about twice the highest listed price to absorb small changes.
const qwen = 'qwen/qwen3.8-27b';
const deepseek = 'deepseek/deepseek-v4.1-flash';
const qwenDeepInfra = {prompt: 0.3, completion: 3.75};
const qwenAlibaba = {prompt: 0.85, completion: 5.1};
const deepseekDeepInfra = {prompt: 0.3, completion: 0.9};
const deepseekOfficial = {prompt: 0.6, completion: 2.4};
const qwenFlash = 'qwen/qwen3.8-flash';
const qwenFlashAlibaba = {prompt: 0.3, completion: 0.95};
/** Smallest thinking budget the fallback tier uses: a short plan before the answer,
 * leaving most of the default 1024 output tokens for the reply itself. */
const QWEN_FLASH_MIN_THINKING_TOKENS = 256;

export const builtInConfigs: readonly ProbeConfig[] = Object.freeze([
  {id: 'qwen-deepinfra-none', model: qwen, route: 'deepinfra', effort: 'none', maxPrice: qwenDeepInfra},
  {id: 'qwen-deepinfra-low', model: qwen, route: 'deepinfra', effort: 'low', maxPrice: qwenDeepInfra},
  {id: 'qwen-alibaba-none', model: qwen, route: 'alibaba', effort: 'none', maxPrice: qwenAlibaba},
  {id: 'qwen-alibaba-low', model: qwen, route: 'alibaba', effort: 'low', maxPrice: qwenAlibaba},
  {id: 'deepseek-deepinfra-none', model: deepseek, route: 'deepinfra', effort: 'none', maxPrice: deepseekDeepInfra},
  {id: 'deepseek-deepinfra-low', model: deepseek, route: 'deepinfra', effort: 'low', maxPrice: deepseekDeepInfra},
  {id: 'deepseek-official-none', model: deepseek, route: 'deepseek', effort: 'none', maxPrice: deepseekOfficial},
  {id: 'deepseek-official-low', model: deepseek, route: 'deepseek', effort: 'low', maxPrice: deepseekOfficial},
  // AC-0d. Alibaba refused tool requests carrying data_collection deny in an
  // earlier probe. Owner decision 2026-09-28: requests need not carry "do not
  // train" unless GDPR or similar privacy law requires it; the Owner approved
  // this probe to call Alibaba without it. Every other config still sends deny.
  {id: 'qwen-flash-alibaba-off', model: qwenFlash, route: 'alibaba', reasoning: {enabled: false},
    maxPrice: qwenFlashAlibaba, dataCollection: 'omit'},
  {id: 'qwen-flash-alibaba-min', model: qwenFlash, route: 'alibaba', reasoning: {max_tokens: QWEN_FLASH_MIN_THINKING_TOKENS},
    maxPrice: qwenFlashAlibaba, dataCollection: 'omit'},
] satisfies ProbeConfig[]);

export const DEFAULT_CONFIG_IDS = ['qwen-deepinfra-none', 'qwen-deepinfra-low'];

/** OpenRouter provider routing for every probe call. Mirrors the real path
 * (openRouterPolicy.ts: one route, no fallbacks, parameters required) and adds
 * data_collection deny, which the real path does not send yet (RUNTIME-PROD),
 * unless the config explicitly omits it. */
export function routing(config: ProbeConfig) {
  return {
    only: [config.route],
    allow_fallbacks: false as const,
    require_parameters: true as const,
    ...(config.dataCollection === 'omit' ? {} : {data_collection: 'deny' as const}),
    max_price: {prompt: config.maxPrice.prompt, completion: config.maxPrice.completion},
  };
}

export function resolveConfigs(ids: string[], extra: unknown): ProbeConfig[] {
  const registry = new Map<string, ProbeConfig>(builtInConfigs.map(config => [config.id, config]));
  if (extra !== undefined) {
    const parsed = z.array(probeConfig).max(32).safeParse(extra);
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 5).map(issue => (issue.path.join('.') || '(root)') + ' ' + issue.code);
      throw new Error('PROBE_CONFIG_FILE_INVALID: ' + where.join('; '));
    }
    for (const config of parsed.data) {
      if (config.dataCollection !== undefined) throw new Error('PROBE_CONFIG_FILE_INVALID: dataCollection is built-in only');
      registry.set(config.id, config);
    }
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
