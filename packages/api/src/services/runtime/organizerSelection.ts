/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { rowsFor, type ConfigurationRows } from './settingsRows';
import { summaryPolicy } from '../artifacts/summaryPolicy';
import { stagingRpcFailure } from './stagingErrors';

/** A separate organizer turn runs on the administrator's summary model (moved out of admission.ts unchanged). */
export async function organizerSelection(admin: SupabaseClient, dialogueModelId: string | null | undefined, real: boolean,
  configuration: <T>(read: () => T) => T,
  /** DB-PERF PR-3: this admission's settings rows (settingsRows.ts); absent, the settings are read now. */
  settingRows?: Promise<ConfigurationRows>) {
  if (!dialogueModelId) throw new Error('RUNTIME_ORGANIZER_SOURCE_REQUIRED');
  const keys = ['v3_summary_model_id', 'v3_summary_max_tokens'];
  const rows = settingRows ? rowsFor(await settingRows, keys) : await admin.from('system_settings').select('key,value').in('key', keys);
  if (rows.error) { if (real) stagingRpcFailure(rows.error); throw new Error('RUNTIME_ORGANIZER_DENIED'); }
  const summary = configuration(() => summaryPolicy(Object.fromEntries((rows.data ?? []).map(row => [row.key, row.value])), dialogueModelId));
  return { modelId: summary.modelId, organizerOutput: summary.maxTokens,
    instructions: 'Organize the provided current-session material. Preserve source references and uncertainties. Do not create new facts.' };
}
