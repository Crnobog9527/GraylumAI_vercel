/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { BILLING_CONSTANTS } from '../types/billing';

/**
 * BILL-UNIT configuration: q (credits per USD), the site-wide default multiplier and
 * per-model overrides. Read failures and invalid values reject new charging; only a
 * successfully confirmed missing key or a legal NULL override inherits a default.
 */
// Fallback only for a confirmed-missing row. Kept equal to the pre-BILL-UNIT defaults so merging
// never changes an environment's effective q/m; the Owner-approved q=100/m=3 is written as rows.
export const BILLING_UNIT_DEFAULTS = {
  creditsPerUsd: String(BILLING_CONSTANTS.CREDITS_PER_USD),
  multiplier: String(BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER),
} as const;
export const BILLING_UNIT_SETTING_KEYS = {
  creditsPerUsd: 'billing_credits_per_usd',
  multiplier: 'billing_token_price_multiplier',
} as const;
export const BILLING_UNIT_SNAPSHOT_VERSION = 'bill-unit-v1';
export const MAX_SNAPSHOT_MODELS = 16;

export type BillingUnitErrorCode =
  | 'BILLING_UNIT_SETTINGS_UNAVAILABLE'
  | 'BILLING_UNIT_SETTINGS_INVALID'
  | 'BILLING_UNIT_MODEL_UNAVAILABLE'
  | 'BILLING_UNIT_MODEL_MISSING'
  | 'BILLING_UNIT_MULTIPLIER_INVALID'
  | 'BILLING_UNIT_SNAPSHOT_INVALID'
  | 'BILLING_UNIT_MODEL_NOT_APPROVED'
  | 'BILLING_UNIT_ROUTE_NOT_APPROVED'
  | 'BILLING_UNIT_PROVIDER_PRICES_UNAVAILABLE'
  | 'BILLING_UNIT_PROVIDER_PRICES_INVALID'
  | 'BILLING_UNIT_PROVIDER_PRICE_UNKNOWN'
  | 'BILLING_UNIT_PROVIDER_PRICE_EXPIRED'
  | 'BILLING_UNIT_PROVIDER_USAGE_INVALID';

export class BillingUnitConfigError extends Error {
  constructor(public readonly code: BillingUnitErrorCode) {
    super(code);
    this.name = 'BillingUnitConfigError';
  }
}

/** Client-facing form: the configuration is unavailable; internal codes and values stay in logs. */
export function billingUnitPublicError(cause: unknown): TRPCError {
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '计费配置暂不可用，新的收费已暂停，请稍后重试', cause });
}

const MULTIPLIER_PATTERN = /^(?:(?:[1-9]|1[0-9])(?:\.[0-9]{1,2})?|20(?:\.0{1,2})?)$/;
const CREDITS_PER_USD_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/;

function decimalText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function canonical(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** A multiplier is 1–20 with at most two decimals; values are never rounded or clamped. */
export function parseMultiplier(value: unknown): string {
  const text = decimalText(value);
  if (text === null || !MULTIPLIER_PATTERN.test(text)) {
    throw new BillingUnitConfigError('BILLING_UNIT_MULTIPLIER_INVALID');
  }
  return canonical(text);
}

/** Model / provider overrides: NULL means inherit the site default. */
export function parseOptionalMultiplier(value: unknown): string | null {
  return value === null ? null : parseMultiplier(value);
}

export function parseCreditsPerUsd(value: unknown): string {
  const text = decimalText(value);
  if (text === null || !CREDITS_PER_USD_PATTERN.test(text) || !/[1-9]/.test(text)) {
    throw new BillingUnitConfigError('BILLING_UNIT_SETTINGS_INVALID');
  }
  return canonical(text);
}

export type BillingUnitSettings = {
  creditsPerUsd: string;
  defaultMultiplier: string;
  source: { creditsPerUsd: 'configured' | 'default'; defaultMultiplier: 'configured' | 'default' };
};

type SettingRow = { key: unknown; value: unknown };

export function billingUnitSettingsFromRows(rows: readonly SettingRow[]): BillingUnitSettings {
  const read = (key: string) => {
    const matches = rows.filter((row) => row.key === key);
    if (matches.length > 1) throw new BillingUnitConfigError('BILLING_UNIT_SETTINGS_INVALID');
    return matches[0];
  };
  const qRow = read(BILLING_UNIT_SETTING_KEYS.creditsPerUsd);
  const mRow = read(BILLING_UNIT_SETTING_KEYS.multiplier);
  let defaultMultiplier: string;
  try {
    defaultMultiplier = mRow ? parseMultiplier(mRow.value) : BILLING_UNIT_DEFAULTS.multiplier;
  } catch {
    throw new BillingUnitConfigError('BILLING_UNIT_SETTINGS_INVALID');
  }
  return {
    creditsPerUsd: qRow ? parseCreditsPerUsd(qRow.value) : BILLING_UNIT_DEFAULTS.creditsPerUsd,
    defaultMultiplier,
    source: { creditsPerUsd: qRow ? 'configured' : 'default', defaultMultiplier: mRow ? 'configured' : 'default' },
  };
}

export async function readBillingUnitSettings(db: SupabaseClient): Promise<BillingUnitSettings> {
  const { data, error } = await db
    .from('system_settings')
    .select('key, value')
    .in('key', [BILLING_UNIT_SETTING_KEYS.creditsPerUsd, BILLING_UNIT_SETTING_KEYS.multiplier]);
  if (error || !Array.isArray(data)) throw new BillingUnitConfigError('BILLING_UNIT_SETTINGS_UNAVAILABLE');
  return billingUnitSettingsFromRows(data as SettingRow[]);
}

export type MultiplierSource = 'model' | 'provider' | 'global';
export type ResolvedMultiplier = { multiplier: string; source: MultiplierSource };

/** The row must carry the column: an undeployed or unselected field is an error, not NULL. */
export function resolveModelMultiplier(row: Record<string, unknown>, defaultMultiplier: string): ResolvedMultiplier {
  if (!Object.hasOwn(row, 'price_multiplier')) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_UNAVAILABLE');
  const override = parseOptionalMultiplier(row.price_multiplier);
  return override === null
    ? { multiplier: parseMultiplier(defaultMultiplier), source: 'global' }
    : { multiplier: override, source: 'model' };
}

export type MultiplierSnapshot = {
  version: typeof BILLING_UNIT_SNAPSHOT_VERSION;
  creditsPerUsd: string;
  defaultMultiplier: string;
  models: Readonly<Record<string, ResolvedMultiplier>>;
  /** Third-party routes keyed by providerRouteKey(); priced separately, multiplier frozen here. */
  providers: Readonly<Record<string, ResolvedMultiplier>>;
  hash: string;
};

export const providerRouteKey = (provider: string, route: string) => `${provider} ${route}`;

function canonicalMap(map: Readonly<Record<string, ResolvedMultiplier>>) {
  return Object.keys(map).sort().map((key) => [key, map[key]!.multiplier, map[key]!.source]);
}

function snapshotHash(body: Omit<MultiplierSnapshot, 'hash'>): string {
  const canonicalBody = JSON.stringify([
    body.version, body.creditsPerUsd, body.defaultMultiplier, canonicalMap(body.models), canonicalMap(body.providers),
  ]);
  return createHash('sha256').update(canonicalBody).digest('hex');
}

function frozenMap(map: Readonly<Record<string, ResolvedMultiplier>>, own: MultiplierSource) {
  const keys = Object.keys(map);
  if (keys.length > MAX_SNAPSHOT_MODELS) throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  return Object.fromEntries(keys.sort().map((key) => {
    const entry = map[key]!;
    if (entry.source !== own && entry.source !== 'global') throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
    return [key, { multiplier: parseMultiplier(entry.multiplier), source: entry.source }];
  }));
}

export function buildMultiplierSnapshot(
  settings: Pick<BillingUnitSettings, 'creditsPerUsd' | 'defaultMultiplier'>,
  models: Readonly<Record<string, ResolvedMultiplier>>,
  providers: Readonly<Record<string, ResolvedMultiplier>> = {},
): MultiplierSnapshot {
  if (Object.keys(models).length + Object.keys(providers).length === 0) {
    throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  }
  const body = {
    version: BILLING_UNIT_SNAPSHOT_VERSION,
    creditsPerUsd: parseCreditsPerUsd(settings.creditsPerUsd),
    defaultMultiplier: parseMultiplier(settings.defaultMultiplier),
    models: frozenMap(models, 'model'),
    providers: frozenMap(providers, 'provider'),
  } as const;
  return { ...body, hash: snapshotHash(body) };
}

/** Reads q and the default, then the approved models' overrides. These are separate reads, not one
 * transaction: the frozen snapshot that results is the authority for the operation. Third-party
 * route multipliers are resolved by the caller (billingProviderPrices) against the same default. */
export async function readMultiplierSnapshot(
  db: SupabaseClient,
  modelIds: readonly string[],
  resolveProviders?: (defaultMultiplier: string) => Readonly<Record<string, ResolvedMultiplier>>,
): Promise<MultiplierSnapshot> {
  const ids = [...new Set(modelIds)];
  if (ids.length > MAX_SNAPSHOT_MODELS || (ids.length === 0 && !resolveProviders)) {
    throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  }
  const settings = await readBillingUnitSettings(db);
  const models: Record<string, ResolvedMultiplier> = {};
  if (ids.length > 0) {
    const { data, error } = await db.from('ai_models').select('id, price_multiplier').in('id', ids);
    if (error || !Array.isArray(data)) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_UNAVAILABLE');
    const rows = data as Array<Record<string, unknown>>;
    for (const id of ids) {
      const matches = rows.filter((row) => row.id === id);
      if (matches.length !== 1) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_MISSING');
      models[id] = resolveModelMultiplier(matches[0]!, settings.defaultMultiplier);
    }
  }
  return buildMultiplierSnapshot(settings, models, resolveProviders?.(settings.defaultMultiplier) ?? {});
}

function assertSnapshot(snapshot: MultiplierSnapshot) {
  const maps: unknown[] = [snapshot?.models, snapshot?.providers];
  if (!snapshot || snapshot.version !== BILLING_UNIT_SNAPSHOT_VERSION
    || maps.some((map) => typeof map !== 'object' || map === null || Array.isArray(map))
    || snapshotHash(snapshot) !== snapshot.hash) {
    throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  }
}

/** A call may only use a model frozen into its operation's snapshot. */
export function multiplierForCall(snapshot: MultiplierSnapshot, modelId: string) {
  assertSnapshot(snapshot);
  const entry = Object.hasOwn(snapshot.models, modelId) ? snapshot.models[modelId] : undefined;
  if (!entry) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_NOT_APPROVED');
  return { multiplier: entry.multiplier, source: entry.source, snapshotHash: snapshot.hash };
}

/** Same rule for a third-party route: only routes frozen at admission may be charged. */
export function multiplierForProviderCall(snapshot: MultiplierSnapshot, provider: string, route: string) {
  assertSnapshot(snapshot);
  const key = providerRouteKey(provider, route);
  const entry = Object.hasOwn(snapshot.providers, key) ? snapshot.providers[key] : undefined;
  if (!entry) throw new BillingUnitConfigError('BILLING_UNIT_ROUTE_NOT_APPROVED');
  return { multiplier: entry.multiplier, source: entry.source, snapshotHash: snapshot.hash };
}
