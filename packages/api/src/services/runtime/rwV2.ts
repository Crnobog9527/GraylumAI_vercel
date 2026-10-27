/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {rowFor, type ConfigurationRows} from './settingsRows';

/**
 * DB-RW: the per-step switches of the database read/write redesign, one JSON setting. Every step is off unless the
 * setting says `true` for it, so a missing, unreadable or malformed setting means the previous behaviour.
 */
export const RW_V2_KEY = 'runtime_rw_v2';
export type RwV2 = {admitSplit: boolean};

export function readRwV2(rows: ConfigurationRows): RwV2 {
  const row = rowFor(rows, RW_V2_KEY);
  const value = row.error ? null : row.data?.value;
  const flags = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {admitSplit: flags.admitSplit === true};
}
