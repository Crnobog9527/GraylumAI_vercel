/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { ConnectError, type PendingConnect } from './connect';
import { deleteAccount, getAccount, type ClientDeps } from './postForMe/client';

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

/**
 * Deletes accounts this attempt imported but the user did not keep. Each one is re-read first and deleted only if
 * it still carries this attempt's exact external_id (a newer attempt or another user may have taken it since).
 * Anything not settled here is left for the daily orphan sweep (PR-2c); this never throws.
 */
export async function cleanupUnselected(client: ClientDeps, externalId: string, ids: string[]): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], kept: [], deferred: [] };
  for (const id of ids) {
    try {
      const account = await getAccount(client, id);
      if (account.kind === 'rejected') { result.kept.push(id); continue; }
      if (account.kind !== 'ok') { result.deferred.push(id); continue; }
      if (account.value.externalId !== externalId) { result.kept.push(id); continue; }
      const removed = await deleteAccount(client, id);
      (removed.kind === 'ok' ? result.deleted : result.deferred).push(id);
    } catch {
      result.deferred.push(id);
    }
  }
  if (result.deferred.length > 0) {
    logger.warn('api', 'publish_monitor_connect_cleanup_deferred', { count: result.deferred.length });
  }
  return result;
}

export type CandidateView = PendingConnect['candidates'][number] & { username: string | null };

/**
 * Display names for the confirmation page. Only accounts the database listed for this actor's own attempt are read,
 * so a user can never look up someone else's account by putting its id in a URL.
 */
export async function describeCandidates(client: ClientDeps, pending: PendingConnect): Promise<CandidateView[]> {
  const views: CandidateView[] = [];
  for (const candidate of pending.candidates.slice(0, 50)) {
    let username: string | null = null;
    if (candidate.kind !== 'unavailable') {
      const account = await getAccount(client, candidate.providerAccountId).catch(() => null);
      if (account?.kind === 'ok' && account.value.platform === pending.platform) username = account.value.username;
    }
    views.push({ ...candidate, username });
  }
  return views;
}
