/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';
import type { frozenCallPolicy } from '../bill2/service';
import { openRouterBound } from '../bill2/openRouterPolicy';
import { openRouterSearchParameters } from '../openRouterSearch';
import { PURPOSE_INPUT_CAPS } from '../runtime/purposeBudgets';
import { frozenReasoningFields, type ReasoningPolicy } from '../runtime/reasoningPolicy';

/** The input snapshot (report + collected material) reuses the interactive 90000-byte cap; the whole
 * request (with instructions and, for the summary, the opinions) stays within the per-call profile bound. */
export const FUSION_INPUT_CAP = PURPOSE_INPUT_CAPS.interactive;
export function assertSnapshotSize(report: string, materials: unknown) {
  if (Buffer.byteLength(report) + Buffer.byteLength(JSON.stringify(materials)) > FUSION_INPUT_CAP) {
    throw new Error('FUSION_INPUT_TOO_LARGE');
  }
}
/** `history`: earlier turns of the conversation as plain messages (compare columns, FUSION-COMPARE §3.2); reviews send none. */
export type FusionRequest = { instructions: string; input: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  responseFormat?: Record<string, unknown> };
const cached = (text: string) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
/** PROMPT-CACHE-ALL: on an Anthropic route with a frozen write price, the host-written system message (shared by every
 * review or compare of the same kind) and the last earlier turn of a compare are cache breakpoints; the text is unchanged. */
const messagesOf = (request: FusionRequest, cache = false) => {
  const history = request.history ?? [];
  return [{ role: 'system', content: cache ? cached(request.instructions) : request.instructions },
    ...history.map((turn, index) => cache && index === history.length - 1 && turn.content ? { ...turn, content: cached(turn.content) } : turn),
    { role: 'user', content: request.input }];
};
export const cacheMarkersFor = (policy: Pick<z.infer<typeof frozenCallPolicy>, 'model' | 'providerLimits'>) =>
  policy.model.startsWith('anthropic/') && policy.providerLimits?.cacheWriteUsdPerMillion !== undefined;

/** Exact provider bytes for one Fusion call. The host writes every message: no brand identity
 * statement is added (Fusion shows the real model name), no history, no tools and no tool_choice;
 * the legacy web plugin is explicitly off (FUSION-REVIEW §4.1). */
/** Serialized size of a request as fusionRequestBody sends it (content escaped inside the outer JSON), plus room for
 * the model, routing, limits and reasoning fields. Used to keep every review step within the per-call byte cap. */
export const REQUEST_FIELDS_ALLOWANCE = 8192;
export function fusionRequestBytes(request: FusionRequest): number {
  return Buffer.byteLength(JSON.stringify({ messages: messagesOf(request),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}) })) + REQUEST_FIELDS_ALLOWANCE;
}

export function fusionRequestBody(policy: z.infer<typeof frozenCallPolicy>, request: FusionRequest,
  outputLimit: number, reasoning?: ReasoningPolicy): string {
  if (!request.instructions.trim() || !request.input.trim()) throw new Error('FUSION_REQUEST_INVALID');
  if (!policy.providerLimits) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
  const { plugins } = openRouterSearchParameters(policy.model, false);
  return JSON.stringify({
    model: policy.model, stream: true, stream_options: { include_usage: true }, store: false,
    messages: messagesOf(request, cacheMarkersFor(policy)),
    provider: openRouterBound(policy.providerLimits, policy.outputLimit).routing, max_tokens: outputLimit,
    ...frozenReasoningFields(reasoning),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    plugins,
  });
}
