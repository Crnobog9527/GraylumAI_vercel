/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { paygStartThresholdsSchema } from '../adminSettings';
import { aggregateCredits } from '../bill2/decimal';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';
import { parseStagingPolicy, type StagingPolicy } from '../runtime/stagingPolicy';
import { readPaygHostPolicies } from '../runtime/paygHostPolicy';
import { freezeStagingPaygPricing } from '../runtime/paygPricing';
import { freezeWindowBillingUnit } from '../runtime/billingUnitAdmission';
import { admitReasoning } from '../runtime/reasoningAdmission';
import { PURPOSE_OUTPUT_CAP, readPurposeBudgets } from '../runtime/purposeBudgets';
import { readPricingSnapshot } from '../../shared/modelPricing';
import { PRICE_SNAPSHOT_MAX_AGE_MS } from '../runtime/pricingAdmission';
import { reportModelErrorCode } from './modelErrors';

type Model = { id: string; name: string; model_id: string; provider: string; is_active: string;
  input_limit: number; max_tokens: number; config: unknown };
const columns = 'id,name,model_id,provider,is_active,input_limit,max_tokens,config';
const unavailable = () => new Error('REPORT_MODEL_CONFIG_UNAVAILABLE');
export async function readReportModel(db: SupabaseClient, moduleId: string) {
  const result = await db.from('modules').select('id,model_id,report_model_id').eq('id', moduleId).maybeSingle();
  if (result.error) throw unavailable();
  if (!result.data) throw new Error('REPORT_MODULE_NOT_FOUND');
  return { moduleId: result.data.id as string, dialogueModelId: result.data.model_id as string | null,
    reportModelId: result.data.report_model_id as string | null,
    effectiveModelId: (result.data.report_model_id ?? result.data.model_id) as string | null };
}
async function windowPolicy(db: SupabaseClient, actorId: string) {
  const windowId = stagingRuntimeWindow(process.env);
  // Administrators need not be test-call actors. This RPC is admin-only and does not admit a call.
  const result = await db.rpc('report_model_window', { p_actor_id: actorId, p_window_id: windowId });
  if (result.error) throw unavailable();
  return parseStagingPolicy(result.data, windowId);
}
async function eligible(db: SupabaseClient, window: StagingPolicy, row: Model) {
  if (row.is_active !== 'true' || !['openrouter', 'openai', 'anthropic'].includes(row.provider))
    throw new Error('REPORT_MODEL_UNAVAILABLE');
  const quote = window.callPolicies.find(p => p.modelId === row.id);
  if (!quote || quote.model !== row.model_id || !quote.providerLimits
    || !Number.isSafeInteger(row.input_limit) || row.input_limit < quote.providerLimits.contextTokens
    || !Number.isSafeInteger(row.max_tokens) || row.max_tokens < 1)
    throw new Error('REPORT_MODEL_ADMISSION_REQUIRED');
  const outputLimit = Math.min(PURPOSE_OUTPUT_CAP, row.max_tokens, quote.outputLimit);
  const reasoning = admitReasoning(row, 'interactive', quote.providerLimits.providerSlug, outputLimit);
  const policies = await readPaygHostPolicies(db, window, [quote], [{ modelId: row.id, phase: 'report',
    outputLimit, reasoning, requestFormat: 'agent-turn-v5-stream' }], process.env,
    new Date(Math.min(Date.now() + 3600000, Date.parse(window.expiresAt))).toISOString());
  if (!policies) throw new Error('REPORT_MODEL_ADMISSION_REQUIRED');
  // Settings reads/writes never renew catalog state or call a provider. New runtime admission
  // retains the existing price-renewal path and revalidates everything before freezing.
  const snapshot = readPricingSnapshot(row.config);
  if (!snapshot || Date.now() - Date.parse(snapshot.fetchedAt) > PRICE_SNAPSHOT_MAX_AGE_MS)
    throw new Error('REPORT_MODEL_PRICING_UNAVAILABLE');
  await freezeStagingPaygPricing(db, policies, { read: async () => { throw unavailable(); } });
  await freezeWindowBillingUnit(db, window, [quote]);
  await readPurposeBudgets(db);
  const result = await db.from('system_settings').select('value').eq('key', 'billing_payg_start_thresholds').maybeSingle();
  if (result.error) throw unavailable();
  const parsed = paygStartThresholdsSchema.safeParse(result.data?.value);
  const threshold = parsed.success
    ? parsed.data.thresholds.find(p => p.model === row.model_id && p.purpose === 'report') : undefined;
  if (!threshold) throw new Error('REPORT_MODEL_ADMISSION_REQUIRED');
  if (typeof threshold.typicalUsd === 'string') {
    try { aggregateCredits([threshold.typicalUsd], window.creditsPerUsd, quote.multiplier!); }
    catch { throw new Error('REPORT_MODEL_ADMISSION_REQUIRED'); }
  }
  return { id: row.id, name: row.name, model: row.model_id };
}
export async function reportModelOptions(db: SupabaseClient, actorId: string) {
  const window = await windowPolicy(db, actorId);
  const result = await db.from('ai_models').select(columns).in('id', window.callPolicies.map(p => p.modelId));
  if (result.error) throw unavailable();
  const models: Array<{ id: string; name: string; model: string }> = [];
  for (const row of (result.data ?? []) as Model[]) {
    try { models.push(await eligible(db, window, row)); }
    catch (error) {
      const code = reportModelErrorCode(error instanceof Error ? error.message : undefined);
      if (!code || code === 'REPORT_MODEL_CONFIG_UNAVAILABLE') throw unavailable();
    }
  }
  return { models };
}
export async function saveReportModel(db: SupabaseClient, actorId: string, input: {
  moduleId: string; reportModelId: string | null; expectedReportModelId: string | null;
}) {
  await readReportModel(db, input.moduleId);
  if (input.reportModelId !== null) {
    const window = await windowPolicy(db, actorId);
    const result = await db.from('ai_models').select(columns).eq('id', input.reportModelId).maybeSingle();
    if (result.error) throw unavailable();
    if (!result.data) throw new Error('REPORT_MODEL_UNAVAILABLE');
    await eligible(db, window, result.data as Model);
  }
  let query = db.from('modules').update({ report_model_id: input.reportModelId, updated_at: new Date().toISOString() })
    .eq('id', input.moduleId);
  query = input.expectedReportModelId === null ? query.is('report_model_id', null)
    : query.eq('report_model_id', input.expectedReportModelId);
  const result = await query.select('id');
  if (result.error) throw unavailable();
  if (result.data?.length !== 1) throw new Error('REPORT_MODEL_CONFLICT');
  return readReportModel(db, input.moduleId);
}
