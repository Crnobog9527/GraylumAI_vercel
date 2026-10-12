/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/** D5 data-use consent (AGENT-CORE R10). Only service-role RPCs touch the consent table (0212). */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const timestamp = z.string().min(1).nullable();
const stateSchema = z.object({
  purpose: z.literal('team_improvement'), currentVersion: z.string().min(1), granted: z.boolean(),
  version: z.string().min(1).nullable(), grantedAt: timestamp, revokedAt: timestamp,
}).strict();
export type DataUseConsentState = z.infer<typeof stateSchema>;
export const dataUseConsentInput = z.object({
  granted: z.boolean(), version: z.string().regex(/^[a-z0-9-]{1,64}$/),
}).strict();

export type DataUseErrorCode = 'DATA_USE_VERSION_STALE' | 'DATA_USE_ACCOUNT_CLOSED' | 'DATA_USE_UNAVAILABLE';
export class DataUseError extends Error {
  constructor(readonly code: DataUseErrorCode) { super(code); }
}
const known: DataUseErrorCode[] = ['DATA_USE_VERSION_STALE', 'DATA_USE_ACCOUNT_CLOSED'];
function failure(error: { message?: string } | null | undefined): DataUseError {
  const code = known.find(item => error?.message?.includes(item));
  return new DataUseError(code ?? 'DATA_USE_UNAVAILABLE');
}

export async function readDataUseConsent(db: Rpc, profileId: string): Promise<DataUseConsentState> {
  const result = await db.rpc('data_use_consent_state', { a: uuid.parse(profileId) });
  if (result.error) throw failure(result.error);
  const parsed = stateSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

export async function setDataUseConsent(db: Rpc, profileId: string,
  input: z.infer<typeof dataUseConsentInput>): Promise<DataUseConsentState> {
  const { granted, version } = dataUseConsentInput.parse(input);
  const result = await db.rpc('data_use_consent_set', { a: uuid.parse(profileId), p_granted: granted, p_version: version });
  if (result.error) throw failure(result.error);
  const parsed = stateSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

const FILTER_CHUNK = 1000;
/**
 * The single server-side gate for team-improvement reads (case views, exports, admin analysis of
 * user records). Rows whose owner has no current consent are dropped; any failure drops everything
 * by throwing, never by returning unfiltered rows. Not for a user's own reads of their own data.
 */
export async function filterTeamReadable<T>(db: Rpc, rows: readonly T[], ownerOf: (row: T) => string): Promise<T[]> {
  const owner = (row: T) => uuid.parse(ownerOf(row)).toLowerCase();
  const owners = [...new Set(rows.map(owner))];
  const allowed = new Set<string>();
  for (let i = 0; i < owners.length; i += FILTER_CHUNK) {
    const chunk = owners.slice(i, i + FILTER_CHUNK);
    const result = await db.rpc('data_use_team_readable', { p_profile_ids: chunk });
    if (result.error) throw failure(null);
    const ids = z.array(z.union([uuid, z.object({ data_use_team_readable: uuid }).strict()])).safeParse(result.data);
    if (!ids.success) throw failure(null);
    for (const id of ids.data) {
      const value = (typeof id === 'string' ? id : id.data_use_team_readable).toLowerCase();
      if (!chunk.includes(value)) throw failure(null);
      allowed.add(value);
    }
  }
  return rows.filter(row => allowed.has(owner(row)));
}

/** Retention for the consent audit (DATA-ERASURE E6): one year after revocation. */
export async function expireDataUseConsentAudit(db: Rpc, signal?: AbortSignal): Promise<number> {
  const call = db.rpc('data_use_consent_expire', {});
  const result = await (signal ? call.abortSignal(signal) : call);
  if (result.error) throw failure(null);
  return z.number().int().nonnegative().parse(result.data);
}
