/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const SUMMARY_MODEL_SETTING = 'v3_summary_model_id';
export const SUMMARY_OUTPUT_SETTING = 'v3_summary_max_tokens';
export const DEFAULT_SUMMARY_MAX_TOKENS = 2048;
const uuid = z.string().uuid();
const limit = z.coerce.number().int().min(128).max(4096);

/** Summary selection is explicit: missing or invalid settings never select the dialogue model. */
export function summaryPolicy(settings: Record<string, unknown>, dialogueModelId: string) {
  const selected = uuid.safeParse(settings[SUMMARY_MODEL_SETTING]);
  if (!selected.success) throw new Error('SUMMARY_MODEL_NOT_CONFIGURED');
  if (selected.data === dialogueModelId) throw new Error('SUMMARY_MODEL_MUST_DIFFER');
  const output = limit.safeParse(settings[SUMMARY_OUTPUT_SETTING] ?? DEFAULT_SUMMARY_MAX_TOKENS);
  if (!output.success) throw new Error('SUMMARY_OUTPUT_LIMIT_INVALID');
  return { modelId: selected.data, maxTokens: output.data };
}

/** Separate records for the same provider model cannot bypass model-role separation. */
export function assertSeparateSummaryModel(dialogueProviderModel: string, summaryProviderModel: string) {
  if (dialogueProviderModel.trim().toLowerCase() === summaryProviderModel.trim().toLowerCase()) {
    throw new Error('SUMMARY_MODEL_MUST_DIFFER');
  }
}
