/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';
import { StagingAccessError } from './stagingErrors';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
export const PURPOSE_BUDGET_KEY = 'runtime_purpose_budgets';
// Derived from full frozen payload measurements, including duplicated input,
// attached organization and JSON escaping. See MENTOR-BUDGET.md.
export const PURPOSE_INPUT_CAPS = { interactive: 90000, organize: 112000, report: 90000 } as const;
// 2 * 8192 * 8 serialized bytes + 8192 envelope bytes = 139264.
// The second copy reserves reasoning duplicated in reasoning_details.
// Shared with response and frame capacity without loading admission dependencies.
export { PURPOSE_OUTPUT_CAP };
// Reader compatibility only: never use this to admit a new configured budget.
export const FROZEN_OUTPUT_CAP = 128000;
export const PURPOSE_HISTORY_CAP = 1000;
const base = (max: number) => z.object({
  inputBytes: z.number().int().min(1024).max(max),
  historyItems: z.number().int().min(0).max(PURPOSE_HISTORY_CAP),
}).strict();
const output = z.number().int().positive().max(PURPOSE_OUTPUT_CAP);
export const purposeBudgetsSchema = z.object({
  version: z.literal(1),
  interactive: base(PURPOSE_INPUT_CAPS.interactive).extend({ maxOutputTokens: output }).strict(),
  organize: base(PURPOSE_INPUT_CAPS.organize),
  report: base(PURPOSE_INPUT_CAPS.report).extend({ maxOutputTokens: output }).strict(),
}).strict();
export type PurposeBudgets = z.infer<typeof purposeBudgetsSchema>;
export type BudgetPurpose = keyof typeof PURPOSE_INPUT_CAPS;
export const frozenPurposeBudget = z.object({
  purpose: z.enum(['interactive', 'organize', 'report']), inputBytes: z.number().int().positive().max(112000),
  historyItems: z.number().int().min(0).max(PURPOSE_HISTORY_CAP),
}).strict();
export async function readPurposeBudgets(db: SupabaseClient): Promise<PurposeBudgets | null> {
  const result = await db.from('system_settings').select('key,value').eq('key', PURPOSE_BUDGET_KEY).maybeSingle();
  if (result.error) throw new StagingAccessError('RUNTIME_BUDGET_CONFIG_UNAVAILABLE');
  if (!result.data) return null;
  try {
    return purposeBudgetsSchema.parse(typeof result.data.value === 'string' ? JSON.parse(result.data.value) : result.data.value);
  } catch { throw new StagingAccessError('RUNTIME_BUDGET_CONFIG_INVALID'); }
}

export async function readPurposeBudgetView(db: SupabaseClient) {
  const config = await readPurposeBudgets(db);
  const summary = await db.from('system_settings').select('value').eq('key', 'v3_summary_max_tokens').maybeSingle();
  if (summary.error) throw new Error('RUNTIME_BUDGET_CONFIG_UNAVAILABLE');
  const maxOutputTokens = z.coerce.number().int().min(128).max(4096).parse(summary.data?.value ?? 2048);
  return { version: 1 as const, config, source: config ? 'configured' as const : 'legacy' as const,
    limits: { inputBytes: PURPOSE_INPUT_CAPS, maxOutputTokens: PURPOSE_OUTPUT_CAP, historyItems: PURPOSE_HISTORY_CAP },
    organizeOutput: { source: 'v3_summary_max_tokens' as const, maxOutputTokens },
    legacy: { interactive: { inputBytes: 64000, historyItems: 100, fixtureMaxOutputTokens: 1000,
      realOutput: 'min(approved quote, model, 20000)' }, organize: { historyItems: 0 }, report: { active: false } },
  };
}
export async function savePurposeBudgets(db: SupabaseClient, input: PurposeBudgets) {
  const { error } = await db.from('system_settings').upsert({
    key: PURPOSE_BUDGET_KEY, value: JSON.stringify(input),
  }, { onConflict: 'key' });
  if (error) throw new StagingAccessError('RUNTIME_BUDGET_CONFIG_UNAVAILABLE');
  return readPurposeBudgetView(db);
}
