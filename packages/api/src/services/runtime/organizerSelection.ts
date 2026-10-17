/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { summaryPolicy } from '../artifacts/summaryPolicy';
import { stagingRpcFailure } from './stagingErrors';

/** A separate organizer turn runs on the administrator's summary model (moved out of admission.ts unchanged). */
export async function organizerSelection(admin: SupabaseClient, dialogueModelId: string | null | undefined, real: boolean,
  configuration: <T>(read: () => T) => T) {
  if (!dialogueModelId) throw new Error('RUNTIME_ORGANIZER_SOURCE_REQUIRED');
  const rows = await admin.from('system_settings').select('key,value').in('key', ['v3_summary_model_id', 'v3_summary_max_tokens']);
  if (rows.error) { if (real) stagingRpcFailure(rows.error); throw new Error('RUNTIME_ORGANIZER_DENIED'); }
  const summary = configuration(() => summaryPolicy(Object.fromEntries(rows.data.map(row => [row.key, row.value])), dialogueModelId));
  return { modelId: summary.modelId, organizerOutput: summary.maxTokens,
    instructions: 'Organize the provided current-session material. Preserve source references and uncertainties. Do not create new facts.' };
}
