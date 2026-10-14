/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { ConnectError, type PendingConnect } from './connect';
import { deleteAccount, disconnectAccount, getAccount, type ClientDeps } from './postForMe/client';

/**
 * PUBLISH-MONITOR PR-2b-2 (plan §4.1): ties an attempt to the browser that started it and cleans up accounts the
 * user did not keep. The database decides ownership; this layer only adds the browser binding and provider calls.
 */
export const CONNECT_COOKIE = 'graylum_pm_connect';
export const CONNECT_COOKIE_MAX_AGE_SECONDS = 20 * 60;
const uuid = z.string().uuid();

/** The attempt id from the httpOnly cookie set when this browser started the attempt, or null. */
export function boundRequestId(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== CONNECT_COOKIE) continue;
    const value = rest.join('=').trim();
    return uuid.safeParse(value).success ? value.toLowerCase() : null;
  }
  return null;
}

/** A callback, confirmation page or decision for an attempt this browser did not start is refused. */
export function assertBound(cookieHeader: string | null | undefined, requestId: string): void {
  if (boundRequestId(cookieHeader) !== requestId.toLowerCase()) throw new ConnectError('PUBLISH_MONITOR_REQUEST_INVALID');
}

export type CleanupResult = { deleted: string[]; kept: string[]; deferred: string[] };
// Confirm and cancel have already made the attempt final before cleanup runs, so cleanup must finish well inside
// the request: it stops at the first provider outage or after this budget and leaves the rest to the sweep.
const CLEANUP_BUDGET_MS = 45_000;
const NAMES_BUDGET_MS = 15_000;

/**
 * Deletes accounts this attempt imported but the user did not keep. Each one is re-read first and deleted only if
 * it still carries this attempt's exact external_id (a newer attempt or another user may have taken it since).
 * Anything not settled here is left for the daily orphan sweep (PR-2c); this never throws.
 */
export async function cleanupUnselected(client: ClientDeps, externalId: string, ids: string[],
  now: () => number = Date.now): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], kept: [], deferred: [] };
  const until = now() + CLEANUP_BUDGET_MS;
  let outage = false;
  for (const id of ids) {
    if (outage || now() >= until) { result.deferred.push(id); continue; }
    try {
      const account = await getAccount(client, id);
      // Only 404 proves the account is gone; 401/403 and other refusals are deferred for reconciliation.
      if (account.kind === 'rejected' && account.status === 404) { result.kept.push(id); continue; }
      if (account.kind !== 'ok') { outage = true; result.deferred.push(id); continue; }
      if (account.value.externalId !== externalId) { result.kept.push(id); continue; }
      const removed = await deleteAccount(client, id);
      if (removed.kind === 'ok') result.deleted.push(id);
      else { outage = true; result.deferred.push(id); }
    } catch {
      outage = true;
      result.deferred.push(id);
    }
  }
  if (result.deferred.length > 0) {
    logger.warn('api', 'publish_monitor_connect_cleanup_deferred', { count: result.deferred.length });
  }
  return result;
}

/**
 * A proven takeover (plan §4.1 step 2): the database has already quarantined the previous owner's connection; the
 * overwriting authorization is now cleared at the provider too, so neither side can keep using it. Each account is
 * re-read just before disconnecting and cleared only while it still carries this attempt's external_id, so a grant
 * the original owner made since the callback is never revoked. Anything not settled is logged for the PR-2c retry.
 */
export async function disconnectTakenOver(client: ClientDeps, accounts: Array<{ id: string; externalId: string }>,
  now: () => number = Date.now) {
  const until = now() + CLEANUP_BUDGET_MS;
  let pending = 0;
  for (const { id, externalId } of accounts) {
    if (pending > 0 || now() >= until) { pending += 1; continue; }
    try {
      const current = await getAccount(client, id);
      if (current.kind === 'rejected' && current.status === 404) continue;
      if (current.kind !== 'ok') { pending += 1; continue; }
      // Re-authorized by someone else since the callback (for example the original owner): not ours to revoke.
      if (current.value.externalId !== externalId) continue;
      const result = await disconnectAccount(client, id);
      // Only success or "no such account" (404) settles it; 401/403 and other refusals still need reconciliation.
      if (!(result.kind === 'ok' || (result.kind === 'rejected' && result.status === 404))) pending += 1;
    } catch {
      pending += 1;
    }
  }
  if (pending > 0) logger.warn('api', 'publish_monitor_takeover_disconnect_deferred', { count: pending });
  return { pending };
}

export type CandidateView = PendingConnect['candidates'][number] & { username: string | null };

/**
 * Display names for the confirmation page. Only accounts the database listed for this actor's own attempt are read,
 * so a user can never look up someone else's account by putting its id in a URL.
 */
export async function describeCandidates(client: ClientDeps, pending: PendingConnect,
  now: () => number = Date.now): Promise<CandidateView[]> {
  const views: CandidateView[] = [];
  const until = now() + NAMES_BUDGET_MS;
  // Names are optional: after the first provider problem or the time budget, the rest show their account ID.
  let lookups = true;
  for (const candidate of pending.candidates.slice(0, 20)) {
    let username: string | null = null;
    if (lookups && candidate.kind !== 'unavailable' && now() < until) {
      const account = await getAccount(client, candidate.providerAccountId).catch(() => null);
      if (account?.kind === 'ok' && account.value.platform === pending.platform) username = account.value.username;
      else if (account?.kind !== 'rejected') lookups = false;
    }
    views.push({ ...candidate, username });
  }
  return views;
}
