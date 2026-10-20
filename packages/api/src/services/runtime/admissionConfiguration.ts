/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type {SupabaseClient} from '@supabase/supabase-js';
import {RUNTIME_RATE_LIMIT_KEY} from './rateLimitSettings';
import {MODEL_IDENTITY_GUARD_KEY} from '../modelIdentity/guardSetting';
import {RESEARCH_TOOLS_KEY} from '../research/vendors/config';
import {PURPOSE_BUDGET_KEY} from './purposeBudgets';
import {SUMMARY_MODEL_SETTING, SUMMARY_OUTPUT_SETTING} from '../artifacts/summaryPolicy';

export type ConfigurationRows = {data: Array<{key: string; value: unknown}> | null; error: unknown};
/** One new admission's configuration snapshot only. Never reused by the per-call
 * pause/rate gate, execution, another admission or a recovery request. */
export async function readAdmissionConfiguration(admin: SupabaseClient): Promise<ConfigurationRows> {
  try {
    return await admin.from('system_settings').select('key,value').in('key', [
      RUNTIME_RATE_LIMIT_KEY, MODEL_IDENTITY_GUARD_KEY, 'primary_model_id', RESEARCH_TOOLS_KEY,
      PURPOSE_BUDGET_KEY, SUMMARY_MODEL_SETTING, SUMMARY_OUTPUT_SETTING,
    ]);
  } catch (error) { return {data: null, error}; }
}
