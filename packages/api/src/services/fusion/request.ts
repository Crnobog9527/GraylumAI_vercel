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
export type FusionRequest = { instructions: string; input: string; responseFormat?: Record<string, unknown> };

/** Exact provider bytes for one Fusion call. The host writes every message: no brand identity
 * statement is added (Fusion shows the real model name), no history, no tools and no tool_choice;
 * the legacy web plugin is explicitly off (FUSION-REVIEW §4.1). */
/** Serialized size of a request as fusionRequestBody sends it (content escaped inside the outer JSON), plus room for
 * the model, routing, limits and reasoning fields. Used to keep every review step within the per-call byte cap. */
export const REQUEST_FIELDS_ALLOWANCE = 8192;
export function fusionRequestBytes(request: FusionRequest): number {
  return Buffer.byteLength(JSON.stringify({ messages: [{ role: 'system', content: request.instructions },
    { role: 'user', content: request.input }], ...(request.responseFormat ? { response_format: request.responseFormat } : {}) }))
    + REQUEST_FIELDS_ALLOWANCE;
}

export function fusionRequestBody(policy: z.infer<typeof frozenCallPolicy>, request: FusionRequest,
  outputLimit: number, reasoning?: ReasoningPolicy): string {
  if (!request.instructions.trim() || !request.input.trim()) throw new Error('FUSION_REQUEST_INVALID');
  if (!policy.providerLimits) throw new Error('FUSION_MODEL_ADMISSION_REQUIRED');
  const { plugins } = openRouterSearchParameters(policy.model, false);
  return JSON.stringify({
    model: policy.model, stream: true, stream_options: { include_usage: true }, store: false,
    messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.input }],
    provider: openRouterBound(policy.providerLimits, policy.outputLimit).routing, max_tokens: outputLimit,
    ...frozenReasoningFields(reasoning),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    plugins,
  });
}
