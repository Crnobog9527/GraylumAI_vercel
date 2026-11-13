/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../../../lib/logger';
import { swallow } from '../../../lib/swallow';
import { ShotvivaError } from './client';
import type { PartnerErrorCode, PartnerTemplate } from './contract';
import { clearLink, loadShotvivaClient, paidMember, readProfile, type ShotvivaDeps } from './connect';

/** INTEGRATION-SHOTVIVA PR B: one image through the linked Shotviva account. Shotviva charges its own credits; Graylum
 * records nothing and charges nothing (Owner 2026-11-05, no internal settlement). */

/** Up to Shotviva's synchronous generation; the turn has 300 s. */
export const GENERATE_TIMEOUT_MS = 120_000;
/** The replay that asks for the job's state after a timeout. */
const REPLAY_TIMEOUT_MS = 10_000;

export type ImageFailure = PartnerErrorCode | 'unavailable' | 'not_linked' | 'membership_required';
export type ImageOutcome =
  | { status: 'succeeded'; jobId: string; imageUrl: string; viewUrl: string; creditsCharged: number;
      creditsRemaining: number; freeCreditsRemaining: number }
  /** Still generating after the timeout: the card says so and links to Shotviva, never "failed". */
  | { status: 'running'; jobId: string | null; viewUrl: string | null }
  | { status: 'failed'; code: ImageFailure; topUpUrl: string | null; jobId: string | null; refunded: boolean };

const viewUrl = (origin: string, jobId: string) => `${origin}/photos/${encodeURIComponent(jobId)}`;

async function linkedAccount(deps: ShotvivaDeps, profileId: string) {
  const client = await loadShotvivaClient(deps);
  if (!client) return null;
  const row = await readProfile(deps.admin, profileId);
  return row.shotviva_account_id ? { client, accountId: row.shotviva_account_id } : { client, accountId: null };
}

/** The templates for the model to choose from: id, name, what they need. Only the ones that need no photo (reference
 * images are not in the first version, controller 2026-11-12). */
export async function listImageTemplates(deps: ShotvivaDeps & { profileId: string }):
  Promise<{ ok: true; templates: PartnerTemplate[] } | { ok: false; code: ImageFailure }> {
  const linked = await swallow('shotviva_account_read_failed', linkedAccount(deps, deps.profileId), null);
  if (!linked) return { ok: false, code: 'unavailable' };
  if (!linked.accountId) return { ok: false, code: 'not_linked' };
  try {
    const { templates } = await linked.client.templates(linked.accountId);
    return { ok: true, templates: templates.filter(template => template.fields.images.min === 0) };
  } catch (error) {
    if (error instanceof ShotvivaError && error.code === 'link_revoked') await clearLink(deps.admin, deps.profileId, linked.accountId);
    return { ok: false, code: error instanceof ShotvivaError ? error.code : 'unavailable' };
  }
}

/** `callId` is the turn's tool call id: the idempotency key, so a resent call is the same job and is charged once. */
export async function generateImage(deps: ShotvivaDeps & {
  profileId: string; callId: string; templateId: string; copy: Record<string, string>; aspectRatio?: string;
  generateTimeoutMs?: number;
}): Promise<ImageOutcome> {
  const failed = (code: ImageFailure, extra: Partial<{ topUpUrl: string | null; jobId: string | null; refunded: boolean }> = {}) =>
    ({ status: 'failed' as const, code, topUpUrl: null, jobId: null, refunded: false, ...extra });
  let linked: Awaited<ReturnType<typeof linkedAccount>>;
  try {
    linked = await linkedAccount(deps, deps.profileId);
    if (!linked) return failed('unavailable');
    if (!linked.accountId) return failed('not_linked');
    // The plan already trims the tool for free members; checked again at the call (a membership can end mid-session).
    if (!await paidMember(deps.admin, deps.profileId)) return failed('membership_required');
  } catch { return failed('unavailable'); }
  const { client } = linked;
  const accountId = linked.accountId;
  const request = { template_id: deps.templateId, inputs: { copy: deps.copy, ...(deps.aspectRatio ? { aspect_ratio: deps.aspectRatio } : {}) } };
  const settle = (answer: Awaited<ReturnType<typeof client.generate>>): ImageOutcome => answer.status === 'succeeded' && answer.image_url
    ? { status: 'succeeded', jobId: answer.job_id, imageUrl: answer.image_url, viewUrl: viewUrl(client.origin, answer.job_id),
        creditsCharged: answer.credits_charged, creditsRemaining: answer.credits_remaining,
        freeCreditsRemaining: answer.free_credits_remaining }
    : { status: 'running', jobId: answer.job_id, viewUrl: viewUrl(client.origin, answer.job_id) };
  const refused = async (error: ShotvivaError): Promise<ImageOutcome> => {
    if (error.code === 'link_revoked') await clearLink(deps.admin, deps.profileId, accountId);
    return failed(error.code, { topUpUrl: error.topUpUrl, jobId: error.jobId,
      // Shotviva refunds a failed job and charges nothing for a refusal (contract: content_rejected, generation_failed).
      refunded: error.code === 'generation_failed' || error.code === 'content_rejected' });
  };
  try {
    return settle(await client.generate(accountId, request,
      { idempotencyKey: deps.callId, timeoutMs: deps.generateTimeoutMs ?? GENERATE_TIMEOUT_MS }));
  } catch (error) {
    if (!(error instanceof ShotvivaError)) return failed('unavailable');
    if (error.code !== 'unavailable') return refused(error);
  }
  // No answer (timeout or connection): Shotviva may still finish and charge. The same key answers the job's current state
  // instead of generating again; if that is not readable either, the card says "still generating".
  try {
    return settle(await client.generate(accountId, request, { idempotencyKey: deps.callId, timeoutMs: REPLAY_TIMEOUT_MS }));
  } catch (error) {
    if (error instanceof ShotvivaError && error.code !== 'unavailable') return refused(error);
    logger.warn('system', 'shotviva_generate_outcome_unknown', {});
    return { status: 'running', jobId: null, viewUrl: null };
  }
}

export type ImageJobView =
  | { status: 'succeeded'; imageUrl: string; viewUrl: string }
  | { status: 'running'; viewUrl: string }
  | { status: 'failed'; code: 'content_rejected' | 'generation_failed' | ImageFailure; viewUrl: string | null };

/** The card of an image step, live or after a reload: a fresh signed address (it expires after 7 days; the job's page on
 * Shotviva stays). Only a job of the caller's own linked account can be read (Shotviva checks the account header). */
export async function readImageJob(deps: ShotvivaDeps & { profileId: string; jobId: string }): Promise<ImageJobView> {
  const linked = await swallow('shotviva_account_read_failed', linkedAccount(deps, deps.profileId), null);
  if (!linked) return { status: 'failed', code: 'unavailable', viewUrl: null };
  const view = viewUrl(linked.client.origin, deps.jobId);
  if (!linked.accountId) return { status: 'failed', code: 'not_linked', viewUrl: view };
  try {
    const job = await linked.client.job(linked.accountId, deps.jobId);
    if (job.status === 'succeeded' && job.image_url) return { status: 'succeeded', imageUrl: job.image_url, viewUrl: view };
    if (job.status === 'running') return { status: 'running', viewUrl: view };
    return { status: 'failed', code: job.error ?? 'generation_failed', viewUrl: view };
  } catch (error) {
    if (error instanceof ShotvivaError && error.code === 'link_revoked') await clearLink(deps.admin, deps.profileId, linked.accountId);
    return { status: 'failed', code: error instanceof ShotvivaError ? error.code : 'unavailable', viewUrl: view };
  }
}

/** Image bytes are fetched only from Shotviva's own origin or its R2 storage (the signed address), never elsewhere. */
const R2_HOST = /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/i;
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The card's image, through Graylum (the page's CSP stays as it is and the signed address never reaches the browser): the job
 * must be the caller's own and finished; the address must be https on Shotviva or R2; no redirects; a size and type check. */
export async function fetchJobImage(deps: ShotvivaDeps & { profileId: string; jobId: string; fetch?: typeof fetch }):
  Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; status: 404 | 502 }> {
  const job = await readImageJob(deps);
  if (job.status !== 'succeeded') return { ok: false, status: 404 };
  let url: URL;
  try { url = new URL(job.imageUrl); } catch { return { ok: false, status: 502 }; }
  const shotvivaHost = deps.baseUrl ? new URL(deps.baseUrl).hostname : null;
  if (url.protocol !== 'https:' || url.username || url.password || !(R2_HOST.test(url.hostname) || url.hostname === shotvivaHost)) {
    logger.warn('system', 'shotviva_image_host_refused', {});
    return { ok: false, status: 502 };
  }
  try {
    const response = await (deps.fetch ?? fetch)(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!response.ok || !IMAGE_TYPES.has(type) || Number(response.headers.get('content-length')) > IMAGE_MAX_BYTES || !response.body) {
      return { ok: false, status: 502 };
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > IMAGE_MAX_BYTES) { await reader.cancel(); return { ok: false, status: 502 }; }
      parts.push(next.value);
    }
    return { ok: true, bytes: Buffer.concat(parts), contentType: type };
  } catch { return { ok: false, status: 502 }; }
}
