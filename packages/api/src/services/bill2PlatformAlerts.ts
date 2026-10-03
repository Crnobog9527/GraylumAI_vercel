/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';

export const ABSORB_CONFIG_KEY = 'billing_platform_absorb_alert';
export const ABSORB_ACK_KEY = 'billing_platform_absorb_ack';
const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/);
const model = z.string().min(1).max(200).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const absorbConfigSchema = z.object({
  defaultUsd: decimal,
  models: z.record(model, decimal).refine(v => Object.keys(v).length <= 1000),
}).strict();
export const absorbAckInput = z.object({ model, utcDate: date }).strict();
const acknowledgements = z.record(model, date).refine(v => Object.keys(v).length <= 1000);
export type AbsorbConfig = z.infer<typeof absorbConfigSchema>;
export type AbsorbRow = {
  model: string; utc_date: string; credits_per_usd: string; call_multiplier: string;
  platform_cap_credits: string; platform_bound_credits: string;
};
const SCALE = 10n ** 12n;
const DAY = 86400000;
const fixed = (v: string) => {
  if (!decimal.safeParse(v).success) throw new Error('Invalid decimal');
  const [whole, fraction = ''] = v.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
};
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
const own = (record: Record<string, string>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const display = (n: bigint, d: bigint) => {
  const rounded = (n * SCALE * 2n + d) / (2n * d);
  return `${rounded / SCALE}.${(rounded % SCALE).toString().padStart(12, '0')}`;
};
function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'BILL2_PLATFORM_ALERT_UNAVAILABLE' });
}
function parseStored(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function readSetting(db: SupabaseClient, key: string) {
  const result = await db.from('system_settings').select('value').eq('key', key).maybeSingle();
  if (result.error) unavailable();
  return result.data;
}
export async function readAbsorbConfig(db: SupabaseClient) {
  try {
    const row = await readSetting(db, ABSORB_CONFIG_KEY);
    return row ? absorbConfigSchema.parse(parseStored(row.value)) : null;
  } catch { return unavailable(); }
}
export async function saveAbsorbConfig(db: SupabaseClient, input: AbsorbConfig) {
  const config = absorbConfigSchema.parse(input);
  try {
    const { error } = await db.from('system_settings')
      .upsert({ key: ABSORB_CONFIG_KEY, value: config }, { onConflict: 'key' });
    if (error) unavailable();
    return await readAbsorbConfig(db);
  } catch { return unavailable(); }
}

/** Atomic compare-and-swap of the complete JSONB, including concurrent first creation. */
export async function acknowledgeAbsorb(db: SupabaseClient, input: z.infer<typeof absorbAckInput>, now = new Date()) {
  const parsed = absorbAckInput.parse(input);
  if (parsed.utcDate > now.toISOString().slice(0, 10)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'BILL2_PLATFORM_ALERT_FUTURE_DATE' });
  }
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const row = await readSetting(db, ABSORB_ACK_KEY);
      const stored = row ? acknowledgements.parse(parseStored(row.value)) : {};
      if ((own(stored, parsed.model) ?? '') >= parsed.utcDate) return stored;
      const value = acknowledgements.parse({ ...stored, [parsed.model]: parsed.utcDate });
      if (!row) {
        const inserted = await db.from('system_settings').insert({ key: ABSORB_ACK_KEY, value }).select('key');
        if (inserted.error?.code === '23505') continue;
        if (inserted.error) unavailable();
        if (inserted.data?.length) return value;
      } else {
        const saved = await db.from('system_settings').update({ value })
          .eq('key', ABSORB_ACK_KEY).eq('value', JSON.stringify(row.value)).select('key');
        if (saved.error) unavailable();
        if (saved.data?.length) return value;
      }
    }
  } catch { return unavailable(); }
  throw new TRPCError({ code: 'CONFLICT', message: 'BILL2_PLATFORM_ALERT_RETRY' });
}

/** Exact rational comparison: rounding occurs only in the returned display amount. */
export function calculateAbsorbAlerts(rows: AbsorbRow[], config: AbsorbConfig, ack: Record<string, string>, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const first = new Date(Date.parse(today) - 6 * DAY).toISOString().slice(0, 10);
  const groups = new Map<string, { model: string; utcDate: string; n: bigint; d: bigint }>();
  for (const row of rows) {
    model.parse(row.model);
    date.parse(row.utc_date);
    if (row.utc_date < first || row.utc_date > today) continue;
    const q = fixed(row.credits_per_usd);
    const m = fixed(row.call_multiplier);
    if (q <= 0n || m <= 0n || !/^\d+$/.test(row.platform_cap_credits) || !/^\d+$/.test(row.platform_bound_credits)) {
      throw new Error('Invalid platform amount');
    }
    const n = (BigInt(row.platform_cap_credits) + BigInt(row.platform_bound_credits)) * SCALE * SCALE;
    const d = q * m;
    const key = `${row.model}\u0000${row.utc_date}`;
    const previous = groups.get(key) ?? { model: row.model, utcDate: row.utc_date, n: 0n, d: 1n };
    const nextN = previous.n * d + n * previous.d;
    const nextD = previous.d * d;
    const divisor = gcd(nextN, nextD);
    groups.set(key, { ...previous, n: nextN / divisor, d: nextD / divisor });
  }
  return [...groups.values()].filter(g => g.utcDate > (own(ack, g.model) ?? '')
    && g.n * SCALE > fixed(own(config.models, g.model) ?? config.defaultUsd) * g.d)
    .map(g => ({ model: g.model, utcDate: g.utcDate, nominalEquivalentUsd: display(g.n, g.d),
      thresholdUsd: own(config.models, g.model) ?? config.defaultUsd }))
    .sort((a, b) => b.utcDate.localeCompare(a.utcDate) || a.model.localeCompare(b.model));
}
export async function readAbsorbAlerts(db: SupabaseClient, now = new Date()) {
  const config = await readAbsorbConfig(db);
  if (!config) return { status: 'disabled' as const, alerts: [] };
  try {
    const ackRow = await readSetting(db, ABSORB_ACK_KEY);
    const ack = ackRow ? acknowledgements.parse(parseStored(ackRow.value)) : {};
    const today = now.toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - 6 * DAY).toISOString();
    const to = new Date(Date.parse(today) + DAY).toISOString();
    const { data, error } = await db.rpc('bill2_payg_absorb_report', { p_from: from, p_to: to });
    if (error || !Array.isArray(data)) unavailable();
    return { status: 'enabled' as const, config, from, to,
      basis: 'frozen_rate_nominal_equivalent_usd' as const, displayDecimals: 12,
      alerts: calculateAbsorbAlerts(data as AbsorbRow[], config, ack, now) };
  } catch { return unavailable(); }
}
