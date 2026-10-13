/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { exchange, type FetchImpl, type PostForMeExchange, publicHttpsUrl } from './http';
import { normalizeFeedPage, type FeedPage } from './normalize';

/**
 * Post for Me client for PUBLISH-MONITOR (plan §4.1). Read paths, consent links and account removal only;
 * there is deliberately no publishing call here (PR-5, every real publish needs Owner approval).
 * Every call passes the shared limiter first: one key serves all users (40/min, 5/s measured 2026-10-13).
 */
export type Limiter = { acquire(): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> };
export type ClientDeps = { apiKey: string; limiter: Limiter; fetchImpl?: FetchImpl; timeoutMs?: number };

export type Outcome<T> =
  | { kind: 'ok'; value: T }
  /** Shared limiter or provider 429: nothing was done; try again after the delay. */
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** The provider answered with a definite client error: the request was not carried out. */
  | { kind: 'rejected'; status: number }
  /** Answered but unusable (5xx, unreadable, wrong shape): treat as "not fetched", keep old data. */
  | { kind: 'failed'; status: number | null; reason: string }
  /** No answer: the request may or may not have taken effect. Callers reconcile; never blindly resend writes. */
  | { kind: 'unknown'; reason: string };

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EXTERNAL_ID = /^[a-z0-9]{16,64}\.[a-z0-9]{16,64}$/;
const PLATFORM = z.enum(['tiktok', 'tiktok_business', 'instagram', 'facebook', 'x', 'threads', 'linkedin',
  'pinterest', 'bluesky', 'youtube']);
export type PostForMePlatform = z.infer<typeof PLATFORM>;

const accountSchema = z.object({
  id: z.string().regex(ACCOUNT_ID),
  platform: z.string().max(32),
  status: z.enum(['connected', 'disconnected']),
  external_id: z.string().max(200).nullable().optional(),
  username: z.string().max(200).nullable().optional(),
}).passthrough();
export type PostForMeAccount = { id: string; platform: string; status: 'connected' | 'disconnected';
  externalId: string | null; username: string | null };

function account(raw: z.infer<typeof accountSchema>): PostForMeAccount {
  return { id: raw.id, platform: raw.platform, status: raw.status, externalId: raw.external_id ?? null,
    username: raw.username ?? null };
}

function classify<T>(result: PostForMeExchange, parse: (json: unknown) => T | null, write: boolean): Outcome<T> {
  const outcome = classifyRead(result, parse);
  // A write that got anything but a definite answer may already have happened at the provider: reconcile, never retry.
  return write && outcome.kind === 'failed' ? { kind: 'unknown', reason: outcome.reason } : outcome;
}

function classifyRead<T>(result: PostForMeExchange, parse: (json: unknown) => T | null): Outcome<T> {
  if (result.kind === 'unknown') return { kind: 'unknown', reason: result.reason };
  if (result.status === 408) return { kind: 'unknown', reason: 'PROVIDER_TIMEOUT' };
  if (result.kind === 'unreadable') {
    if (result.status === 429) return { kind: 'rate_limited', retryAfterSeconds: 60 };
    return result.status >= 400 && result.status < 500
      ? { kind: 'rejected', status: result.status } : { kind: 'failed', status: result.status, reason: result.reason };
  }
  if (result.status === 429) return { kind: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds ?? 60 };
  if (result.status >= 400 && result.status < 500) return { kind: 'rejected', status: result.status };
  if (result.status < 200 || result.status >= 300) {
    return { kind: 'failed', status: result.status, reason: 'PROVIDER_ERROR' };
  }
  const value = parse(result.json);
  return value === null ? { kind: 'failed', status: result.status, reason: 'RESPONSE_SHAPE' } : { kind: 'ok', value };
}

async function call<T>(deps: ClientDeps, request: Parameters<typeof exchange>[0],
  parse: (json: unknown) => T | null): Promise<Outcome<T>> {
  const slot = await deps.limiter.acquire();
  if (!slot.ok) return { kind: 'rate_limited', retryAfterSeconds: slot.retryAfterSeconds };
  // Creating a consent link changes nothing the user relies on; account removal/disconnect does.
  const write = request.method === 'DELETE' || request.path.endsWith('/disconnect');
  return classify(await exchange(request, deps.apiKey, deps), parse, write);
}

function assertAccountId(id: string) {
  if (!ACCOUNT_ID.test(id)) throw new Error('POSTFORME_ACCOUNT_ID_INVALID');
}

export function getAccount(deps: ClientDeps, id: string): Promise<Outcome<PostForMeAccount>> {
  assertAccountId(id);
  return call(deps, { method: 'GET', path: `/social-accounts/${id}` }, json => {
    const parsed = accountSchema.safeParse(json);
    return parsed.success ? account(parsed.data) : null;
  });
}

export type AccountPage = { accounts: PostForMeAccount[]; nextOffset: number | null };
const PAGE = 100;
const accountPage = z.object({
  data: z.array(accountSchema).max(PAGE),
  meta: z.object({ total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
    limit: z.number().int().positive() }).passthrough(),
}).passthrough();

function listPage(deps: ClientDeps, offset: number, externalId?: string): Promise<Outcome<AccountPage>> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('POSTFORME_OFFSET_INVALID');
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (externalId) query.set('external_id', externalId);
  return call(deps, { method: 'GET', path: `/social-accounts?${query}` }, json => {
    const parsed = accountPage.safeParse(json);
    if (!parsed.success || parsed.data.meta.offset !== offset) return null;
    const next = offset + parsed.data.data.length;
    return { accounts: parsed.data.data.map(account),
      nextOffset: parsed.data.data.length > 0 && next < parsed.data.meta.total ? next : null };
  });
}

/**
 * Accounts carrying one exact external_id (what an attempt imported, plan §4.1), one page at a time;
 * callers keep calling with nextOffset until it is null, so no imported account is left unmanaged.
 */
export function listAccountsByExternalId(deps: ClientDeps, externalId: string, offset = 0): Promise<Outcome<AccountPage>> {
  if (!EXTERNAL_ID.test(externalId)) throw new Error('POSTFORME_EXTERNAL_ID_INVALID');
  return listPage(deps, offset, externalId);
}

/** Every account in the project, one page at a time (daily orphan sweep, plan §4.1). */
export function listAllAccounts(deps: ClientDeps, offset = 0): Promise<Outcome<AccountPage>> {
  return listPage(deps, offset);
}

export type AuthUrlInput = { platform: PostForMePlatform; externalId: string; permissions: Array<'feeds' | 'posts'>;
  connectionType?: 'organization' | 'instagram' | 'facebook';
  /** Required when publishing access is being added, so the platform grants it afresh (plan §4.1). */
  forceReauth?: boolean;
  /** Bluesky only: the user's handle and app password, forwarded once to the provider, never stored or logged. */
  bluesky?: { handle: string; appPassword: string } };

/** Consent link for the user's own account. Read-only scope unless publishing consent was given (plan §4.1). */
export function createAuthUrl(deps: ClientDeps, input: AuthUrlInput): Promise<Outcome<string>> {
  const platform = PLATFORM.parse(input.platform);
  if (!EXTERNAL_ID.test(input.externalId)) throw new Error('POSTFORME_EXTERNAL_ID_INVALID');
  const permissions = [...new Set(input.permissions)].sort();
  if (permissions.length === 0 || !permissions.includes('feeds')) throw new Error('POSTFORME_PERMISSIONS_INVALID');
  let platformData: Record<string, unknown> | undefined;
  if (platform === 'linkedin') platformData = { linkedin: { connection_type: input.connectionType ?? 'organization' } };
  if (platform === 'instagram') {
    if (input.connectionType !== 'instagram' && input.connectionType !== 'facebook') {
      throw new Error('POSTFORME_INSTAGRAM_CONNECTION_TYPE_REQUIRED');
    }
    platformData = { instagram: { connection_type: input.connectionType } };
  }
  if (platform === 'bluesky') {
    const handle = input.bluesky?.handle.trim().toLowerCase();
    const appPassword = input.bluesky?.appPassword.trim();
    // Bluesky app passwords are xxxx-xxxx-xxxx-xxxx; a main account password is refused here.
    if (!handle || !/^[a-z0-9.-]{3,253}$/.test(handle) || !appPassword || !/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(appPassword)) {
      throw new Error('POSTFORME_BLUESKY_CREDENTIALS_INVALID');
    }
    platformData = { bluesky: { handle, app_password: appPassword } };
  }
  if (permissions.includes('posts') && input.forceReauth !== true) throw new Error('POSTFORME_PUBLISH_NEEDS_REAUTH');
  return call(deps, { method: 'POST', path: '/social-accounts/auth-url', body: {
    platform, external_id: input.externalId, permissions, ...(platformData ? { platform_data: platformData } : {}),
    ...(input.forceReauth ? { force_reauth: true } : {}),
  } }, json => {
    const parsed = z.object({ url: z.string() }).passthrough().safeParse(json);
    return parsed.success ? publicHttpsUrl(parsed.data.url, 4096) : null;
  });
}

export type FeedQuery = { cursor?: string | null; limit?: number; platformPostIds?: string[] };

export function readFeedPage(deps: ClientDeps, accountId: string, platform: string,
  query: FeedQuery = {}): Promise<Outcome<FeedPage>> {
  assertAccountId(accountId);
  const params = new URLSearchParams({ expand: 'metrics', limit: String(Math.min(Math.max(query.limit ?? 100, 1), 100)) });
  if (query.cursor) params.set('cursor', query.cursor);
  for (const id of query.platformPostIds ?? []) {
    if (!/^[A-Za-z0-9_:.-]{1,256}$/.test(id)) throw new Error('POSTFORME_POST_ID_INVALID');
    params.append('platform_post_id', id);
  }
  return call(deps, { method: 'GET', path: `/social-account-feeds/${accountId}?${params}` },
    json => normalizeFeedPage(json, platform));
}

/** Removes the provider account and its history (plan §4.1: delete, not disconnect). Never retried here. */
export function deleteAccount(deps: ClientDeps, id: string): Promise<Outcome<true>> {
  assertAccountId(id);
  return call(deps, { method: 'DELETE', path: `/social-accounts/${id}` }, () => true as const);
}

/** Clears the provider tokens but keeps history; used before deleting an account with unresolved publishes. */
export function disconnectAccount(deps: ClientDeps, id: string): Promise<Outcome<true>> {
  assertAccountId(id);
  return call(deps, { method: 'POST', path: `/social-accounts/${id}/disconnect` }, () => true as const);
}
