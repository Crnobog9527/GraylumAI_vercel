/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../../lib/logger';
import { readOwnDataTier } from '../../membershipEntitlements';
import { getPlatformSecret, PlatformSecretError } from '../../platformSecrets/reader';
import { validPlatformSecret } from '../../platformSecrets/slots';
import { createShotvivaClient, ShotvivaError, type ShotvivaClient } from './client';

/** INTEGRATION-SHOTVIVA PR A: connect a Graylum account to a Shotviva account by the redirect flow of the connector
 * spec (Shotviva 规范/CONNECTOR_shortest_path_fable.md §2): Graylum sends the user to Shotviva's authorize page with a
 * random state kept in an httpOnly cookie; Shotviva sends them back with a one-time code; the server exchanges it with
 * the partner key for the account id, the only thing stored. Free members cannot use the connector (Owner 2026-11-05). */
export const SHOTVIVA_STATE_COOKIE = 'gl_shotviva_state';
export const SHOTVIVA_STATE_MAX_AGE_SECONDS = 600;
export const SHOTVIVA_CALLBACK_PATH = '/api/connectors/shotviva/callback';
const AUTHORIZE_PATH = '/connect/graylum';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShotvivaConnectCode = 'SHOTVIVA_UNAVAILABLE' | 'SHOTVIVA_MEMBERSHIP_REQUIRED' | 'SHOTVIVA_ACCOUNT_CLOSED'
  | 'SHOTVIVA_STATE_INVALID' | 'SHOTVIVA_CODE_INVALID';
export class ShotvivaConnectError extends Error {
  constructor(readonly code: ShotvivaConnectCode) { super(code); }
}

export type ShotvivaDeps = { admin: SupabaseClient; baseUrl: string | undefined; client?: ShotvivaClient | null };

/** The client, or null while the connector is off here (no Shotviva address configured or no partner key in the Vault).
 * A Vault read failure is "unavailable", not "off". */
export async function loadShotvivaClient(deps: ShotvivaDeps): Promise<ShotvivaClient | null> {
  if (deps.client !== undefined) return deps.client;
  if (!deps.baseUrl) return null;
  try {
    const key = (await getPlatformSecret(deps.admin, 'shotviva')).value;
    if (!validPlatformSecret('shotviva', key)) return null;
    return createShotvivaClient({ baseUrl: deps.baseUrl, partnerKey: key });
  } catch (error) {
    if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return null;
    if (error instanceof ShotvivaError) return null;
    throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  }
}

type ProfileRow = { shotviva_account_id: string | null; status: string; is_deleted: unknown };
export async function readProfile(admin: SupabaseClient, profileId: string): Promise<ProfileRow> {
  const { data, error } = await admin.from('profiles').select('shotviva_account_id,status,is_deleted').eq('id', profileId)
    .maybeSingle();
  if (error) throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  if (!data) throw new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED');
  return data as ProfileRow;
}
const active = (row: ProfileRow) => row.status === 'active' && String(row.is_deleted) === 'false';

/** Pro or Gold only, read live (an expired membership is free); any other or missing level is refused. */
const PAID_LEVELS: readonly string[] = ['pro', 'gold'];
export async function paidMember(admin: SupabaseClient, profileId: string): Promise<boolean> {
  try { return PAID_LEVELS.includes(String((await readOwnDataTier(admin, profileId))?.level)); }
  catch { throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE'); }
}

const cookieValue = (profileId: string, state: string) => `${profileId}.${state}`;

/** Step 1: where to send the browser, and the cookie that must come back with Shotviva's answer. */
export async function startShotvivaConnect(deps: ShotvivaDeps & { profileId: string; appOrigin: string }) {
  if (!UUID.test(deps.profileId)) throw new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED');
  const client = await loadShotvivaClient(deps);
  if (!client) throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  if (!active(await readProfile(deps.admin, deps.profileId))) throw new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED');
  if (!await paidMember(deps.admin, deps.profileId)) throw new ShotvivaConnectError('SHOTVIVA_MEMBERSHIP_REQUIRED');
  const state = randomBytes(32).toString('base64url');
  const target = new URL(AUTHORIZE_PATH, client.origin);
  target.searchParams.set('state', state);
  // Shotviva accepts only this exact callback path on an allowlisted Graylum host.
  target.searchParams.set('return_to', new URL(SHOTVIVA_CALLBACK_PATH, deps.appOrigin).toString());
  return { redirectUrl: target.toString(), cookie: cookieValue(deps.profileId, state) };
}

function sameState(cookie: string | undefined, profileId: string, state: string | null): boolean {
  if (!cookie || !state || state.length > 512) return false;
  const expected = Buffer.from(cookieValue(profileId, state));
  const actual = Buffer.from(cookie);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Step 2: Shotviva's redirect back. The state must match the cookie of the same signed-in user (so a link started by
 * someone else, or by another account in this browser, is refused); the code is exchanged once; the id is written only
 * on an open account. */
export async function finishShotvivaConnect(deps: ShotvivaDeps & {
  profileId: string; cookie: string | undefined; state: string | null; code: string | null;
}) {
  if (!UUID.test(deps.profileId) || !sameState(deps.cookie, deps.profileId, deps.state)) {
    throw new ShotvivaConnectError('SHOTVIVA_STATE_INVALID');
  }
  if (!deps.code || deps.code.length < 16 || deps.code.length > 128) throw new ShotvivaConnectError('SHOTVIVA_CODE_INVALID');
  const client = await loadShotvivaClient(deps);
  if (!client) throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  if (!active(await readProfile(deps.admin, deps.profileId))) throw new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED');
  if (!await paidMember(deps.admin, deps.profileId)) throw new ShotvivaConnectError('SHOTVIVA_MEMBERSHIP_REQUIRED');
  let accountId: string;
  try { accountId = (await client.link(deps.code)).account_id; }
  catch (error) {
    if (error instanceof ShotvivaError && error.code === 'invalid_input') throw new ShotvivaConnectError('SHOTVIVA_CODE_INVALID');
    throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  }
  const written = await deps.admin.from('profiles').update({ shotviva_account_id: accountId })
    .eq('id', deps.profileId).eq('status', 'active').eq('is_deleted', 'false').select('id');
  if (written.error) throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
  if (!written.data?.length) throw new ShotvivaConnectError('SHOTVIVA_ACCOUNT_CLOSED');
  return { accountId };
}

export type ShotvivaStatus = {
  /** The connector is configured here (address and partner key). */
  available: boolean;
  /** Pro or Gold: may connect and use it. */
  eligible: boolean;
  connected: boolean;
  /** Present when connected and Shotviva answered; null when it could not be read just now. */
  balance: { credits: number; freeCredits: number; paidUntil: string | null; topUpUrl: string } | null;
};

/** For the integrations page. A link the user revoked on Shotviva comes back as link_revoked: the id is cleared (only if
 * it is still the same id) and the account shows as not connected. */
export async function readShotvivaStatus(deps: ShotvivaDeps & { profileId: string }): Promise<ShotvivaStatus> {
  const [client, row, eligible] = await Promise.all([loadShotvivaClient(deps), readProfile(deps.admin, deps.profileId),
    paidMember(deps.admin, deps.profileId)]);
  const accountId = row.shotviva_account_id;
  if (!client || !accountId) return { available: !!client, eligible, connected: !!accountId, balance: null };
  try {
    const account = await client.account(accountId);
    return { available: true, eligible, connected: true, balance: { credits: account.credits_remaining,
      freeCredits: account.free_credits_remaining, paidUntil: account.paid_until, topUpUrl: account.top_up_url } };
  } catch (error) {
    if (error instanceof ShotvivaError && error.code === 'link_revoked') {
      await clearLink(deps.admin, deps.profileId, accountId);
      return { available: true, eligible, connected: false, balance: null };
    }
    logger.warn('system', 'shotviva_account_read_failed', { code: error instanceof ShotvivaError ? error.code : 'unknown' });
    return { available: true, eligible, connected: true, balance: null };
  }
}

/** Forget the link here; with an account id, only while it is still that id (a newer link is never cleared). */
export async function clearLink(admin: SupabaseClient, profileId: string, accountId: string | null) {
  const update = admin.from('profiles').update({ shotviva_account_id: null }).eq('id', profileId);
  const { error } = await (accountId === null ? update : update.eq('shotviva_account_id', accountId));
  if (error) throw new ShotvivaConnectError('SHOTVIVA_UNAVAILABLE');
}

/** "断开": forget the account here. The link on Shotviva stays until the user disconnects Graylum there; without the id
 * Graylum can no longer call for this user. */
export async function disconnectShotviva(deps: { admin: SupabaseClient; profileId: string }) {
  await clearLink(deps.admin, deps.profileId, null);
  return { connected: false as const };
}
