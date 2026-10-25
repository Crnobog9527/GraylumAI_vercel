/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { openRouterAccount, readOpenRouterKey } from '../models/openRouterKey';
import { rowFor, type ConfigurationRows } from './settingsRows';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { deriveFrozenPrices } from '../../shared/modelPriceBound';
import { decimal } from '../bill2/decimal';
import { openRouterBound, type OpenRouterLimits } from '../bill2/openRouterPolicy';
import type { FrozenRun } from '../bill2/service';
import { BillingUnitConfigError, readBillingUnitSettings, readMultiplierSnapshot } from '../billingUnit';
import { isOpenRouterEndpoint, resolveOpenAICompatibleEndpoint } from '../providerUtils';
import { isAdmittedRoute, matchedProfile, paygProductionSettings, paygTemplate, PAYG_PRODUCTION_SETTING, PAYG_PROFILE_MAX_BYTES,
  type Requirement } from './paygHostPolicy';
export { PAYG_PRODUCTION_SETTING } from './paygHostPolicy';
import { pricingEndpoint, PRICE_SNAPSHOT_MAX_AGE_MS, readPricingStates, type PricingDeps } from './pricingAdmission';
import { readPricingSnapshot } from '../../shared/modelPricing';
import { productionRuntimeTarget } from './productionEnvironment';
import { StagingAccessError, stagingRpcFailure } from './stagingErrors';
import { parseStagingPolicy, type StagingPolicy } from './stagingPolicy';

/**
 * RUNTIME-PROD production host (docs/launch/tasks/RUNTIME-PROD.md). There is no test window: every new
 * admission derives its quotes from the persisted OpenRouter price snapshot of each admitted model and the
 * configured q/m (Master Plan 2.1 item 40: prices are automatic, a rise needs no approval). The result has
 * the window's shape, so transport, admission and SQL checks reuse their one implementation.
 */
type Settings = z.infer<typeof paygProductionSettings>;
/** The loaded policy is valid for the request that loaded it; the run's own deadline bounds it further. */
const POLICY_HORIZON_MS = 3_600_000;
const isProductionPolicy = (policy: StagingPolicy) => policy.mode === 'production';


/** Actor active/not deleted and this database marked as production: one SQL decision (no client field). */
export async function assertProductionAccess(admin: SupabaseClient, actorId: string) {
  const result = await admin.rpc('runtime_production_access', { p_actor_id: z.string().uuid().parse(actorId) });
  if (result.error) stagingRpcFailure(result.error, 'RUNTIME_PRODUCTION_DENIED', 'RUNTIME_PRODUCTION_TARGET_DENIED');
  if (result.data !== true) throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
}

async function readSettings(admin: SupabaseClient, configuration?: Promise<ConfigurationRows>): Promise<Settings> {
  const { data, error } = configuration ? rowFor(await configuration, PAYG_PRODUCTION_SETTING)
    : await admin.from('system_settings').select('value').eq('key', PAYG_PRODUCTION_SETTING).maybeSingle();
  if (error) throw new StagingAccessError('RUNTIME_PAYG_CONFIG_UNAVAILABLE');
  let value: unknown = data?.value ?? null;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (value !== null && typeof value === 'object' && 'enabled' in value && value.enabled === false)
    throw new StagingAccessError('RUNTIME_PRODUCTION_DISABLED');
  const parsed = paygProductionSettings.safeParse(value);
  if (!parsed.success || new Set(parsed.data.profiles.map(p => p.model)).size !== parsed.data.profiles.length)
    throw new StagingAccessError('RUNTIME_PRODUCTION_CONFIG_INVALID');
  return parsed.data;
}

type ModelRow = { id: string; model_id: string; provider: string | null; api_endpoint: string | null; config: unknown; updated_at: string };
type CallPolicy = StagingPolicy['callPolicies'][number];

function deriveLimits(row: Parameters<typeof pricingEndpoint>[0], snapshot: Parameters<typeof pricingEndpoint>[1],
  model: string, endpointTag: string): OpenRouterLimits {
  const probe = { modelId: row.id, model, providerLimits: { providerSlug: endpointTag, contextTokens: 1,
    promptUsdPerMillion: '0', completionUsdPerMillion: '0', requestUsd: '0' } };
  const endpoint = pricingEndpoint(row, snapshot, probe);
  if (!endpoint.contextLength) throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_MISSING');
  const prices = deriveFrozenPrices(model, endpoint, endpoint.contextLength);
  if (prices === 'UNKNOWN_PRICE_FIELD') throw new StagingAccessError('RUNTIME_PRICE_UNKNOWN_FIELD');
  if (prices === 'NOT_ADMISSIBLE') throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_MISSING');
  return { providerSlug: endpointTag, contextTokens: endpoint.contextLength, promptUsdPerMillion: prices.promptUsdPerMillion,
    completionUsdPerMillion: prices.completionUsdPerMillion, requestUsd: prices.requestUsd,
    ...(prices.cacheWriteUsdPerMillion !== undefined ? { cacheWriteUsdPerMillion: prices.cacheWriteUsdPerMillion } : {}) };
}

function storedState(row: ModelRow, now: number) {
  const snapshot = readPricingSnapshot(row.config);
  if (!snapshot || now - Date.parse(snapshot.fetchedAt) > PRICE_SNAPSHOT_MAX_AGE_MS)
    throw new StagingAccessError('RUNTIME_PRICE_SNAPSHOT_STALE');
  return { row, snapshot };
}

/** Called by the authenticated host for new work. Target and enable switch first, then the database decision. */
export async function loadProductionPolicy(admin: SupabaseClient, actorId: string,
  env: Record<string, string | undefined> = process.env, deps: PricingDeps = {},
  /** offline: settings pages only read stored snapshots; a stale one leaves its model out instead of renewing it. */
  options: { offline?: boolean } = {}): Promise<StagingPolicy> {
  productionRuntimeTarget(env);
  await assertProductionAccess(admin, actorId);
  const config = await readSettings(admin);
  let unitSettings;
  try { unitSettings = await readBillingUnitSettings(admin); }
  catch (cause) { if (cause instanceof BillingUnitConfigError) throw new StagingAccessError('RUNTIME_BILLING_UNIT_UNAVAILABLE'); throw cause; }
  // RUNTIME_PROD_PLAN 2.1: production q and m are explicit rows, never the code fallback.
  if (unitSettings.source.creditsPerUsd !== 'configured' || unitSettings.source.defaultMultiplier !== 'configured')
    throw new StagingAccessError('RUNTIME_BILLING_UNIT_UNAVAILABLE');
  // ADMIN-SECRETS OR-1: the one OpenRouter key lives in the platform Vault slot, not in the model rows. Settings pages
  // (offline) may use a cached read; anything that authorizes a paid call reads it fresh.
  const key = await readOpenRouterKey(admin, { fresh: !options.offline }).catch(() => undefined);
  const rows = await admin.from('ai_models').select('id,model_id,provider,api_endpoint,config,updated_at')
    .in('model_id', config.profiles.map(p => p.model)).eq('is_active', 'true');
  if (rows.error) stagingRpcFailure(rows.error);
  const candidates: Array<{ row: ModelRow; profile: Settings['profiles'][number] }> = [];
  for (const profile of config.profiles) {
    const matches = ((rows.data ?? []) as ModelRow[]).filter(row => row.model_id === profile.model);
    if (matches.length > 1) throw new StagingAccessError('RUNTIME_PRODUCTION_CONFIG_INVALID');
    // Only approved request shapes (#1073 review): schema-valid evidence for another route is not enough.
    if (matches.length === 1 && isAdmittedRoute(profile.model, profile.endpointTag)) candidates.push({ row: matches[0]!, profile });
  }
  const built = await Promise.all(candidates.map(async ({ row, profile }): Promise<Omit<CallPolicy, 'multiplier'> | undefined> => {
    try {
      if (!key || !isOpenRouterEndpoint(resolveOpenAICompatibleEndpoint(row.provider, row.api_endpoint) ?? ''))
        throw new StagingAccessError('RUNTIME_STAGING_MODEL_DENIED');
      const state = options.offline ? storedState(row, (deps.now ?? Date.now)())
        : (await readPricingStates(admin, [{ modelId: row.id, model: row.model_id }], deps)).get(row.id)!;
      const providerLimits = deriveLimits(state.row, state.snapshot, row.model_id, profile.endpointTag);
      return { modelId: row.id, provider: 'openrouter', account: openRouterAccount(key),
        model: row.model_id, protocol: 'openrouter-chat-v1', providerLimits,
        upperUsd: openRouterBound(providerLimits, profile.outputLimit).upperUsd, inputLimit: PAYG_PROFILE_MAX_BYTES,
        outputLimit: profile.outputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    } catch (cause) {
      // One unusable model is left out (it cannot be selected, so it is never charged); the rest stay available.
      logger.warn('api', 'runtime_production_model_unavailable', { modelId: row.id, model: row.model_id,
        reason: cause instanceof Error ? cause.message : 'unknown' });
      return undefined;
    }
  }));
  const quotes = built.filter((q): q is Omit<CallPolicy, 'multiplier'> => q !== undefined);
  if (!quotes.length) throw new StagingAccessError('RUNTIME_PRODUCTION_CONFIG_INVALID');
  let snapshot;
  try { snapshot = await readMultiplierSnapshot(admin, quotes.map(q => q.modelId)); }
  catch (cause) { if (cause instanceof BillingUnitConfigError) throw new StagingAccessError('RUNTIME_BILLING_UNIT_UNAVAILABLE'); throw cause; }
  const callPolicies = quotes.map(q => ({ ...q, multiplier: snapshot.models[q.modelId]!.multiplier }));
  const multiplier = callPolicies.reduce((max, q) => decimal(q.multiplier) > decimal(max) ? q.multiplier : max, callPolicies[0]!.multiplier);
  // The same structural checks a staging window gets (route identity, bound = upperUsd, multipliers).
  try {
    return parseStagingPolicy({ mode: 'production', id: config.policyVersion, callPolicies, creditsPerUsd: snapshot.creditsPerUsd,
      multiplier, expiresAt: new Date((deps.now ?? Date.now)() + POLICY_HORIZON_MS).toISOString() });
  } catch { throw new StagingAccessError('RUNTIME_PRODUCTION_CONFIG_INVALID'); }
}

/** Admission's PAYG profiles for the selected production quotes. Off, missing or invalid refuses: production never
 * falls back to v1. The profile version must still be the one the policy was loaded with. */
export async function readPaygProductionPolicies(admin: SupabaseClient, policy: StagingPolicy,
  policies: FrozenRun['callPolicy'], requirements: Requirement[], env: Record<string, string | undefined>, deadline: string,
  /** DB-PERF PR-3: this admission's settings rows; absent, the setting is read now. */
  configuration?: Promise<ConfigurationRows>) {
  if (!isProductionPolicy(policy)) throw new StagingAccessError('RUNTIME_PRODUCTION_TARGET_DENIED');
  productionRuntimeTarget(env);
  const config = await readSettings(admin, configuration);
  if (config.policyVersion !== policy.id) throw new StagingAccessError('RUNTIME_PAYG_PROFILE_REQUIRED');
  return policies.map(entry => {
    const profile = matchedProfile(config.profiles, entry, requirements);
    if (!profile || !isAdmittedRoute(profile.model, profile.endpointTag)) throw new StagingAccessError('RUNTIME_PAYG_PROFILE_REQUIRED');
    return { ...entry, payg: paygTemplate(profile, 'production-host-v1', policy.id, deadline) };
  });
}
