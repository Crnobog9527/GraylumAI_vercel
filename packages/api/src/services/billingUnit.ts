/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * BILL-UNIT configuration: q (credits per USD), the site-wide default multiplier and
 * per-model overrides. Read failures and invalid values reject new charging; only a
 * successfully confirmed missing key or a legal NULL override inherits a default.
 */
export const BILLING_UNIT_DEFAULTS = { creditsPerUsd: '100', multiplier: '3' } as const;
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
  | 'BILLING_UNIT_MODEL_NOT_APPROVED';

export class BillingUnitConfigError extends Error {
  constructor(public readonly code: BillingUnitErrorCode) {
    super(code);
    this.name = 'BillingUnitConfigError';
  }
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

export type MultiplierSource = 'model' | 'global';
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
  hash: string;
};

function snapshotHash(body: Omit<MultiplierSnapshot, 'hash'>): string {
  const models = Object.keys(body.models).sort().map((id) => [id, body.models[id]!.multiplier, body.models[id]!.source]);
  const canonicalBody = JSON.stringify([body.version, body.creditsPerUsd, body.defaultMultiplier, models]);
  return createHash('sha256').update(canonicalBody).digest('hex');
}

export function buildMultiplierSnapshot(
  settings: Pick<BillingUnitSettings, 'creditsPerUsd' | 'defaultMultiplier'>,
  models: Readonly<Record<string, ResolvedMultiplier>>,
): MultiplierSnapshot {
  const ids = Object.keys(models);
  if (ids.length === 0 || ids.length > MAX_SNAPSHOT_MODELS) throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  const body = {
    version: BILLING_UNIT_SNAPSHOT_VERSION,
    creditsPerUsd: parseCreditsPerUsd(settings.creditsPerUsd),
    defaultMultiplier: parseMultiplier(settings.defaultMultiplier),
    models: Object.fromEntries(ids.sort().map((id) => {
      const entry = models[id]!;
      return [id, { multiplier: parseMultiplier(entry.multiplier), source: entry.source }];
    })),
  } as const;
  return { ...body, hash: snapshotHash(body) };
}

/** Reads q, the default and the approved models' overrides as one admission snapshot. */
export async function readMultiplierSnapshot(db: SupabaseClient, modelIds: readonly string[]): Promise<MultiplierSnapshot> {
  const ids = [...new Set(modelIds)];
  if (ids.length === 0 || ids.length > MAX_SNAPSHOT_MODELS) throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  const settings = await readBillingUnitSettings(db);
  const { data, error } = await db.from('ai_models').select('id, price_multiplier').in('id', ids);
  if (error || !Array.isArray(data)) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_UNAVAILABLE');
  const rows = data as Array<Record<string, unknown>>;
  const models: Record<string, ResolvedMultiplier> = {};
  for (const id of ids) {
    const matches = rows.filter((row) => row.id === id);
    if (matches.length !== 1) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_MISSING');
    models[id] = resolveModelMultiplier(matches[0]!, settings.defaultMultiplier);
  }
  return buildMultiplierSnapshot(settings, models);
}

/** A call may only use a model frozen into its operation's snapshot. */
export function multiplierForCall(snapshot: MultiplierSnapshot, modelId: string) {
  if (snapshot.version !== BILLING_UNIT_SNAPSHOT_VERSION || snapshotHash(snapshot) !== snapshot.hash) {
    throw new BillingUnitConfigError('BILLING_UNIT_SNAPSHOT_INVALID');
  }
  const entry = Object.hasOwn(snapshot.models, modelId) ? snapshot.models[modelId] : undefined;
  if (!entry) throw new BillingUnitConfigError('BILLING_UNIT_MODEL_NOT_APPROVED');
  return { multiplier: entry.multiplier, source: entry.source, snapshotHash: snapshot.hash };
}
