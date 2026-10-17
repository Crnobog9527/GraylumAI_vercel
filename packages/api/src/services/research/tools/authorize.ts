/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Authorization source checks for the benchmark tools (plan §1.2, §1.6, §2.1). A check that does not
// pass means `not_confirmed`: no supplier request, no charge, nothing written to the benchmark table.
// Storage (selection cards, confirmations, refresh grants) arrives with the RT-3 migration; this module
// only depends on the narrow store interface below.
import { canonicalAccount, profileLinksIn, type CanonicalAccount } from './accountLinks';
import type { ResearchToolArgs } from './schemas';
import type { SocialPlatform } from '../vendors/types';

export interface AuthorizationScope {
  userId: string;
  sessionId: string;
}

/** Every lookup is scoped to the caller's user and session; anything else must come back null. */
export interface AuthorizationStore {
  /** Final keywords of a confirmed keyword card. */
  keywordConfirmation(scope: AuthorizationScope, confirmationId: string): Promise<{ keywords: string[] } | null>;
  /** Accounts bound to the option ids the user ticked on a confirmed candidate card (host data, not model text). */
  candidateConfirmation(scope: AuthorizationScope, confirmationId: string): Promise<CanonicalAccount[] | null>;
  /** Body of a message the user wrote in this session. */
  userMessage(scope: AuthorizationScope, messageId: string): Promise<string | null>;
  /** A refresh grant the user created from the interface; `used` once a fetch consumed it. */
  refreshGrant(scope: AuthorizationScope, refreshId: string): Promise<(CanonicalAccount & { used: boolean }) | null>;
}

export type FetchAuthorization =
  | { ok: true; accounts: CanonicalAccount[]; source: ResearchToolArgs<'benchmark_fetch'>['source'] }
  | { ok: false; reason: 'NOT_CONFIRMED' | 'ACCOUNT_INVALID' | 'REFRESH_USED' | 'DUPLICATE_ACCOUNT' };

const key = (item: CanonicalAccount) => `${item.platform}:${item.account}`;

/**
 * All-or-nothing: one unauthorised account rejects the whole call, so a partially trusted list can
 * never trigger a paid request.
 */
export async function authorizeBenchmarkFetch(
  scope: AuthorizationScope, args: ResearchToolArgs<'benchmark_fetch'>, store: AuthorizationStore,
): Promise<FetchAuthorization> {
  const requested: CanonicalAccount[] = [];
  for (const item of args.accounts) {
    const account = canonicalAccount(item.platform as SocialPlatform, item.account);
    if (account === null) return { ok: false, reason: 'ACCOUNT_INVALID' };
    requested.push({ platform: item.platform, account });
  }
  if (new Set(requested.map(key)).size !== requested.length) return { ok: false, reason: 'DUPLICATE_ACCOUNT' };

  let allowed: CanonicalAccount[] | null;
  const { source } = args;
  if (source.kind === 'candidate') {
    allowed = await store.candidateConfirmation(scope, source.confirmationId);
  } else if (source.kind === 'user_message') {
    const body = source.messageId ? await store.userMessage(scope, source.messageId) : null;
    allowed = body === null ? null : profileLinksIn(body);
  } else {
    const grant = await store.refreshGrant(scope, source.refreshId);
    if (!grant) return { ok: false, reason: 'NOT_CONFIRMED' };
    if (grant.used) return { ok: false, reason: 'REFRESH_USED' };
    // One grant refreshes exactly the account it was created for.
    if (requested.length !== 1) return { ok: false, reason: 'NOT_CONFIRMED' };
    allowed = [{ platform: grant.platform, account: grant.account }];
  }
  if (!allowed) return { ok: false, reason: 'NOT_CONFIRMED' };
  const permitted = new Set(allowed.map(key));
  if (!requested.every(item => permitted.has(key(item)))) return { ok: false, reason: 'NOT_CONFIRMED' };
  return { ok: true, accounts: requested, source };
}

export type DiscoverAuthorization =
  | { ok: true; keywords: string[]; platforms: SocialPlatform[] }
  | { ok: false; reason: 'NOT_CONFIRMED' };

/** A fresh discovery must cite the user's keyword confirmation; the keywords come from that record only. */
export async function authorizeDiscoverStart(
  scope: AuthorizationScope, args: { keywordConfirmationId: string; platforms: SocialPlatform[] }, store: AuthorizationStore,
): Promise<DiscoverAuthorization> {
  const record = await store.keywordConfirmation(scope, args.keywordConfirmationId);
  if (!record || record.keywords.length === 0) return { ok: false, reason: 'NOT_CONFIRMED' };
  return { ok: true, keywords: [...record.keywords], platforms: [...args.platforms] };
}
