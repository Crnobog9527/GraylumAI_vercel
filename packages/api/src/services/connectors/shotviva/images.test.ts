/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tier: vi.fn() }));
vi.mock('../../membershipEntitlements', () => ({ readOwnDataTier: mocks.tier }));
import { ShotvivaError } from './client';
import { fetchJobImage, generateImage, listImageTemplates, readImageJob } from './images';

const me = '00000000-0000-4000-8000-000000000001';
const SV = '00000000-0000-4000-8000-0000000000aa';
const JOB = '00000000-0000-4000-8000-0000000000bb';
const KEY = 'graylum:session:call-1:abc';

function db(accountId: string | null = SV) {
  const state = { shotviva_account_id: accountId, status: 'active', is_deleted: 'false' };
  const admin = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...state }, error: null }) }) }),
    update: (values: { shotviva_account_id: null }) => {
      const chain = { eq: () => chain, then: (resolve: (v: unknown) => unknown) => { state.shotviva_account_id = values.shotviva_account_id;
        return Promise.resolve({ error: null }).then(resolve); } };
      return chain;
    },
  }) };
  return { admin: admin as never, state };
}
const answer = { job_id: JOB, status: 'succeeded' as const, image_url: 'https://abc.r2.cloudflarestorage.com/out.webp?sig=1',
  credits_charged: 2, credits_remaining: 8, free_credits_remaining: 1 };
const sv = (over: Record<string, ReturnType<typeof vi.fn>> = {}) => ({ origin: 'https://shotviva.test',
  generate: vi.fn(async () => answer), templates: vi.fn(), job: vi.fn(), ...over }) as never;
const run = (client: unknown, d = db(), over = {}) => generateImage({ admin: d.admin, baseUrl: 'https://shotviva.test', client: client as never,
  profileId: me, callId: KEY, templateId: 'freeform', copy: { prompt: 'a cup' }, ...over });

beforeEach(() => { vi.clearAllMocks(); mocks.tier.mockResolvedValue({ level: 'pro' }); });

describe('generateImage', () => {
  it('one image through the linked account, under the call\'s key; the job page is Shotviva\'s', async () => {
    const client = sv();
    expect(await run(client)).toEqual({ status: 'succeeded', jobId: JOB, imageUrl: answer.image_url,
      viewUrl: `https://shotviva.test/photos/${JOB}`, creditsCharged: 2, creditsRemaining: 8, freeCreditsRemaining: 1 });
    expect((client as unknown as { generate: ReturnType<typeof vi.fn> }).generate).toHaveBeenCalledWith(SV,
      { template_id: 'freeform', inputs: { copy: { prompt: 'a cup' } } }, { idempotencyKey: KEY, timeoutMs: 120_000 });
  });

  it('not linked, a free member, or the connector off: Shotviva is not asked', async () => {
    const client = sv();
    expect(await run(client, db(null))).toMatchObject({ status: 'failed', code: 'not_linked' });
    mocks.tier.mockResolvedValueOnce({ level: 'free' });
    expect(await run(client)).toMatchObject({ status: 'failed', code: 'membership_required' });
    expect(await run(null)).toMatchObject({ status: 'failed', code: 'unavailable' });
    expect((client as unknown as { generate: ReturnType<typeof vi.fn> }).generate).not.toHaveBeenCalled();
  });

  it('a refusal keeps its code: out of credits with the top-up link, a face swap, a revoked link clears the id', async () => {
    const quota = sv({ generate: vi.fn(async () => { throw new ShotvivaError('quota_exhausted', 402, 'https://shotviva.test/pricing?from=graylum'); }) });
    expect(await run(quota)).toEqual({ status: 'failed', code: 'quota_exhausted', topUpUrl: 'https://shotviva.test/pricing?from=graylum',
      jobId: null, refunded: false });
    const swap = sv({ generate: vi.fn(async () => { throw new ShotvivaError('IDENTITY_SWAP_REFUSED', 422); }) });
    expect(await run(swap)).toMatchObject({ status: 'failed', code: 'IDENTITY_SWAP_REFUSED' });
    // Refused once, never retried.
    expect((swap as unknown as { generate: ReturnType<typeof vi.fn> }).generate).toHaveBeenCalledTimes(1);
    const failed = sv({ generate: vi.fn(async () => { throw new ShotvivaError('generation_failed', 500, null, JOB); }) });
    expect(await run(failed)).toMatchObject({ code: 'generation_failed', jobId: JOB, refunded: true });
    const d = db();
    const revoked = sv({ generate: vi.fn(async () => { throw new ShotvivaError('link_revoked', 401); }) });
    expect(await run(revoked, d)).toMatchObject({ code: 'link_revoked' });
    expect(d.state.shotviva_account_id).toBeNull();
  });

  it('no answer in time: asked once more under the same key (the same job, charged once), else "still generating"', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new ShotvivaError('unavailable', null))
      .mockResolvedValueOnce({ ...answer, status: 'running', image_url: null });
    expect(await run(sv({ generate }))).toEqual({ status: 'running', jobId: JOB, viewUrl: `https://shotviva.test/photos/${JOB}` });
    expect(generate.mock.calls.map(call => call[2].idempotencyKey)).toEqual([KEY, KEY]);
    expect(generate.mock.calls[1][2].timeoutMs).toBe(10_000);
    const late = vi.fn().mockRejectedValueOnce(new ShotvivaError('unavailable', null)).mockResolvedValueOnce(answer);
    expect((await run(sv({ generate: late }))).status).toBe('succeeded');
    const gone = vi.fn().mockRejectedValue(new ShotvivaError('unavailable', null));
    expect(await run(sv({ generate: gone }))).toEqual({ status: 'running', jobId: null, viewUrl: null });
    expect(gone).toHaveBeenCalledTimes(2);
  });
});

describe('templates and jobs', () => {
  it('lists every template, those that take a photo too (Owner 2026-11-13: a photo plus a template before launch)', async () => {
    const template = (id: string, min: number) => ({ id, name: id, category: 'c', cover_before_url: null, cover_after_url: null,
      credits_cost: 1, fields: { images: { min, max: min }, copy: [], aspect_ratios: ['1:1'] } });
    const client = sv({ templates: vi.fn(async () => ({ templates: [template('freeform', 0), template('headshot', 1)] })) });
    expect(await listImageTemplates({ admin: db().admin, baseUrl: 'x', client, profileId: me }))
      .toEqual({ ok: true, templates: [template('freeform', 0), template('headshot', 1)] });
    expect(await listImageTemplates({ admin: db(null).admin, baseUrl: 'x', client, profileId: me })).toEqual({ ok: false, code: 'not_linked' });
  });

  it('reads a job of the linked account: done, still running, failed', async () => {
    const job = (over: object) => sv({ job: vi.fn(async () => ({ job_id: JOB, status: 'succeeded', template_id: 'freeform',
      image_url: 'https://abc.r2.cloudflarestorage.com/x', credits_charged: 2, error: null, created_at: 't', finished_at: 't', ...over })) });
    const read = (client: unknown, d = db()) => readImageJob({ admin: d.admin, baseUrl: 'x', client: client as never, profileId: me, jobId: JOB });
    expect(await read(job({}))).toEqual({ status: 'succeeded', imageUrl: 'https://abc.r2.cloudflarestorage.com/x',
      viewUrl: `https://shotviva.test/photos/${JOB}` });
    expect(await read(job({ status: 'running', image_url: null }))).toMatchObject({ status: 'running' });
    expect(await read(job({ status: 'failed', image_url: null, error: 'content_rejected' }))).toMatchObject({ status: 'failed', code: 'content_rejected' });
    expect(await read(job({}), db(null))).toMatchObject({ status: 'failed', code: 'not_linked' });
    const other = sv({ job: vi.fn(async () => { throw new ShotvivaError('not_found', 404); }) });
    expect(await read(other)).toMatchObject({ status: 'failed', code: 'not_found' });
  });
});

describe('fetchJobImage', () => {
  const done = (url: string) => sv({ job: vi.fn(async () => ({ job_id: JOB, status: 'succeeded', template_id: 'f', image_url: url,
    credits_charged: 1, error: null, created_at: 't', finished_at: 't' })) });
  const get = (client: unknown, send: ReturnType<typeof vi.fn>) => fetchJobImage({ admin: db().admin, baseUrl: 'https://shotviva.test',
    client: client as never, profileId: me, jobId: JOB, fetch: send as never });
  const png = (headers: Record<string, string> = {}, size = 8) =>
    vi.fn(async () => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png', ...headers } }));

  it('fetches the bytes of a finished job from R2 or Shotviva itself, without redirects', async () => {
    const send = png();
    const image = await get(done('https://abc.r2.cloudflarestorage.com/out.png?sig=1'), send);
    expect(image).toMatchObject({ ok: true, contentType: 'image/png' });
    expect(send).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
    expect((await get(done('https://shotviva.test/files/x.png'), png())).ok).toBe(true);
    // Shotviva's presigned address is virtual-host style: <bucket>.<account>.r2.cloudflarestorage.com (staging, 2026-11-13).
    expect((await get(done('https://shotviva-media.0123abcd.r2.cloudflarestorage.com/out.png?X-Amz-Signature=s'), png())).ok).toBe(true);
  });

  it('any other host, plain http, credentials, a wrong type or an oversized body is refused', async () => {
    for (const url of ['https://evil.test/x.png', 'http://abc.r2.cloudflarestorage.com/x.png', 'https://u:p@abc.r2.cloudflarestorage.com/x',
      'https://abc.r2.cloudflarestorage.com.evil.test/x', 'not a url',
      // Two labels is the most R2 signs; three, another domain, plain http or credentials are refused.
      'https://a.bucket.account.r2.cloudflarestorage.com/x', 'https://bucket.account.r2.cloudflarestorage.evil.test/x',
      'https://bucket.account.evil.test/x', 'http://bucket.account.r2.cloudflarestorage.com/x',
      'https://u:p@bucket.account.r2.cloudflarestorage.com/x', 'https://bucket.account.r2-cloudflarestorage.com/x',
      'https://bucket..r2.cloudflarestorage.com/x']) {
      const send = png();
      expect(await get(done(url), send), url).toEqual({ ok: false, status: 502 });
      expect(send).not.toHaveBeenCalled();
    }
    const r2 = 'https://abc.r2.cloudflarestorage.com/x';
    expect(await get(done(r2), png({ 'content-type': 'text/html' }))).toEqual({ ok: false, status: 502 });
    expect(await get(done(r2), png({ 'content-length': String(30 * 1024 * 1024) }))).toEqual({ ok: false, status: 502 });
    expect(await get(done(r2), vi.fn(async () => { throw new TypeError('redirect'); }))).toEqual({ ok: false, status: 502 });
  });

  it('a job that is not finished (or not the caller\'s) has no image', async () => {
    const running = sv({ job: vi.fn(async () => { throw new ShotvivaError('not_found', 404); }) });
    expect(await get(running, png())).toEqual({ ok: false, status: 404 });
  });
});

// Owner 2026-11-13: a chat photo becomes the template's photo, sent as the contract's one `image` address.
describe('generateImage with a photo', () => {
  it('sends the photo address as `image`, inside the same idempotent request', async () => {
    const client = sv();
    const image = 'https://auth-staging.graylum.com/api/chat-photos/shared?p=x&t=y';
    expect((await run(client, db(), { templateId: 'headshot', copy: {}, image })).status).toBe('succeeded');
    expect((client as unknown as { generate: ReturnType<typeof vi.fn> }).generate).toHaveBeenCalledWith(SV,
      { template_id: 'headshot', inputs: { copy: {} }, image }, { idempotencyKey: KEY, timeoutMs: 120_000 });
    const plain = sv();
    await run(plain);
    expect((plain as unknown as { generate: ReturnType<typeof vi.fn> }).generate.mock.calls[0]![1]).not.toHaveProperty('image');
  });
});
