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
import {LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY} from './libraryAdmission';
import {OWN_POSTS_SWITCH} from './workspacePosts';
import {RW_V2_KEY} from './rwV2';
import {PAYG_HOST_SETTING, PAYG_PRODUCTION_SETTING} from './paygHostPolicy';
import {BILLING_UNIT_SETTING_KEYS} from '../billingUnit';
import {CHAT_RESEARCH_KEY} from './freeChatResearch';
import {PROVIDER_PRICES_KEY} from '../billingProviderPrices';
import {RESEARCH_THRESHOLDS_KEY} from './researchAdmission';
import type {ConfigurationRows} from './settingsRows';
import {catalogRead} from './catalogCache';
import {CORE_PATH_SETTING, RUNTIME_PAYG_SETTING} from '../turn/settingKeys';
export type {ConfigurationRows} from './settingsRows';
/** DB-PERF PR-3: admission's model row also carries what pricing (updated_at) and the billing unit (price_multiplier) read. */
export const MODEL_ROW_COLUMNS = 'id,model_id,provider,is_active,max_tokens,input_limit,config,api_endpoint,updated_at,price_multiplier';

/** One new admission's configuration snapshot only. Never reused by the per-call
 * pause/rate gate, execution, another admission or a recovery request.
 * DB-PERF PR-3: every setting a new admission reads is in this one query; each reader takes these rows instead of
 * its own query (settingsRows.ts). `raw` is PostgreSQL's own text of the value, which the provider prices hash needs. */
export async function readAdmissionConfiguration(admin: SupabaseClient): Promise<ConfigurationRows> {
  // DB-RW PR-B: kept in this process while the settings catalog is unchanged (catalogCache.ts).
  try {
    return await catalogRead(admin, 'settings', 'admission', () => admin.from('system_settings').select('key,value,raw:value::text').in('key', [
      RUNTIME_RATE_LIMIT_KEY, MODEL_IDENTITY_GUARD_KEY, 'primary_model_id', RESEARCH_TOOLS_KEY,
      PURPOSE_BUDGET_KEY, SUMMARY_MODEL_SETTING, SUMMARY_OUTPUT_SETTING,
      LIBRARY_AGENT_READ_KEY, LIBRARY_RETRIEVAL_KEY, OWN_POSTS_SWITCH, 'publish_monitor_enabled',
      PAYG_HOST_SETTING, PAYG_PRODUCTION_SETTING, BILLING_UNIT_SETTING_KEYS.creditsPerUsd, BILLING_UNIT_SETTING_KEYS.multiplier,
      CHAT_RESEARCH_KEY, RESEARCH_THRESHOLDS_KEY, PROVIDER_PRICES_KEY, RW_V2_KEY, CORE_PATH_SETTING, RUNTIME_PAYG_SETTING,
    ]));
  } catch (error) { return {data: null, error}; }
}

/** DB-RW PR-B: the admission's model row (MODEL_ROW_COLUMNS), kept in this process while the model catalog is unchanged. */
export function readAdmissionModel(admin: SupabaseClient, modelId: string) {
  return catalogRead(admin, 'models', 'admission-model:' + modelId,
    () => admin.from('ai_models').select(MODEL_ROW_COLUMNS).eq('id', modelId).single());
}

/** DB-RW PR-B: the service-role module row, kept while the Skill catalog is unchanged. The user-scoped module read and the
 * package check that follow stay per request. */
export function readAdmissionModule(admin: SupabaseClient, moduleId: string) {
  return catalogRead(admin, 'skills', 'admission-module:' + moduleId, () => admin.from('modules')
    .select('id,active,skill_id,model_id,report_model_id,social_media_related,uses_user_voice').eq('id', moduleId).single());
}
