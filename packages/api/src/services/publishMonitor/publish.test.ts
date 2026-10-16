/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import type { ClientDeps } from './postForMe/client';
import {
  publishFingerprint, reconcilePublishes, refreshPublishJob, submitPublish, type PublishInput,
} from './publish';

// Simulated provider only: no request leaves the test (PR-5 never publishes for real without Owner approval).
const USER = '00000000-0000-4000-8000-00000000a001';
const JOB = '00000000-0000-4000-8000-00000000a002';
const BIZ = '00000000-0000-4000-8000-00000000a003';
const CX = '00000000-0000-4000-8000-00000000a004';
const CY = '00000000-0000-4000-8000-00000000a005';
const LEASE = '00000000-0000-4000-8000-00000000a006';
const MINE = 'a'.repeat(32);
const MEDIA = 'https://data.postforme.dev/storage/v1/object/public/post-media/secret-file.jpg';
const input: PublishInput = {
  idempotencyKey: 'key-00000001', businessId: BIZ, workItemId: null, connectionIds: [CX, CY], caption: 'Hello',
  media: [{ mediaUrl: MEDIA, sha256: 'f'.repeat(64), size: 1000, mimeType: 'image/jpeg' }],
};
const view = (state: string, extra: Record<string, unknown> = {}) => ({ id: JOB, state, businessId: BIZ, workItemId: null,
  targets: [{ connectionId: CX, platform: 'x', status: 'pending', url: null },
    { connectionId: CY, platform: 'youtube', status: 'pending', url: null }],
  holdCredits: 12, chargedCredits: null, manualReview: false, errorCode: null, createdAt: 'now', updatedAt: 'now', ...extra });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const account = (id: string, ref = MINE) => json(200, { id, platform: 'x', status: 'connected', external_id: `${ref}.${'b'.repeat(32)}` });

function provider(responses: Array<Response | Error>, allow: boolean[] = []) {
  const calls: Array<{ line: string; body: unknown }> = [];
  const deps: ClientDeps = { apiKey: 'pfm_test_FAKEKEY000000000000',
    limiter: { acquire: async () => (allow.length && !allow.shift() ? { ok: false, retryAfterSeconds: 9 } : { ok: true }) },
    fetchImpl: async (url, init) => {
      calls.push({ line: `${init.method} ${url.replace(/^.*\/v1/, '')}`, body: init.body ? JSON.parse(String(init.body)) : null });
      const next = responses.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no response');
      return next;
    } };
  return { deps, calls };
}
function database(results: Record<string, unknown[]>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, names: () => calls.map(c => c[0]), db: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    const queue = results[name] ?? [];
    const next = queue.length ? queue.shift() : null;
    if (next instanceof Error) return { data: null, error: { message: next.message } };
    return { data: next, error: null };
  } } as never };
}
const fresh = () => ({
  publish_monitor_publish_claim: [{ ...view('claimed'), replayed: false, quotaAlert: false }],
  publish_monitor_publish_targets: [{ providerAccountIds: ['spc_x', 'spc_y'] }],
  publish_monitor_publish_dispatch: [{ ...view('dispatching'), dispatch: true, providerAccountIds: ['spc_x', 'spc_y'] }],
  publish_monitor_publish_record: [view('unknown')],
  publish_monitor_publish_release: [view('failed')],
  publish_monitor_publish_unknown: [view('unknown')],
});

describe('publish fingerprint', () => {
  it('binds the key to the request content, not to upload links or target order', () => {
    const base = publishFingerprint(input);
    expect(publishFingerprint({ ...input, connectionIds: [CY, CX] })).toBe(base);
    expect(publishFingerprint({ ...input, media: [{ ...input.media[0]!, mediaUrl: `${MEDIA}?again` }] })).toBe(base);
    expect(publishFingerprint({ ...input, caption: 'Hello!' })).not.toBe(base);
    expect(publishFingerprint({ ...input, media: [{ ...input.media[0]!, sha256: 'e'.repeat(64) }] })).not.toBe(base);
    expect(publishFingerprint({ ...input, connectionIds: [CX] })).not.toBe(base);
  });
});

describe('submit publish (simulated provider)', () => {
  it('checks owners, takes the limiter slot, dispatches, and creates exactly one post carrying the job id', async () => {
    const d = database(fresh());
    const p = provider([account('spc_x'), account('spc_y'), json(200, { id: 'sp_1', external_id: JOB, status: 'processing' })]);
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    const job = await submitPublish(d.db, p.deps, USER, input);
    expect(job.state).toBe('unknown');
    expect(d.names()).toEqual(['publish_monitor_publish_claim', 'publish_monitor_publish_targets',
      'publish_monitor_publish_dispatch', 'publish_monitor_publish_record']);
    expect(d.calls[2]![1]).toEqual({ a: USER, p_job: JOB, p_observed: {
      spc_x: { ownerRef: MINE, connected: true }, spc_y: { ownerRef: MINE, connected: true } } });
    expect(p.calls.map(c => c.line)).toEqual(['GET /social-accounts/spc_x', 'GET /social-accounts/spc_y', 'POST /social-posts']);
    expect(p.calls[2]!.body).toEqual({ caption: 'Hello', social_accounts: ['spc_x', 'spc_y'], external_id: JOB,
      media: [{ url: MEDIA }] });
    expect(d.calls[3]![1]).toEqual({ p_job: JOB, p_provider_post_id: 'sp_1', p_results: {} });
    // Neither the database nor the logs ever see the media link or the caption.
    expect(JSON.stringify(d.calls)).not.toContain('secret-file');
    expect(JSON.stringify(d.calls)).not.toContain('Hello');
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain('secret-file');
    info.mockRestore();
    warn.mockRestore();
  });

  it('a replayed request whose job is no longer only claimed never reaches the provider', async () => {
    const d = database({ publish_monitor_publish_claim: [{ ...view('completed'), replayed: true }] });
    const p = provider([]);
    expect((await submitPublish(d.db, p.deps, USER, input)).state).toBe('completed');
    expect(p.calls).toEqual([]);
    expect(d.names()).toEqual(['publish_monitor_publish_claim']);
  });

  it('leaves the job claimed (not possibly sent) when the limiter or an owner check is unavailable', async () => {
    const busy = database(fresh());
    const blocked = provider([account('spc_x'), account('spc_y')], [true, true, false]);
    await expect(submitPublish(busy.db, blocked.deps, USER, input)).rejects.toMatchObject({
      code: 'PUBLISH_MONITOR_PROVIDER_BUSY', retryAfterSeconds: 9 });
    expect(busy.names()).not.toContain('publish_monitor_publish_dispatch');
    expect(blocked.calls.map(c => c.line)).not.toContain('POST /social-posts');
    const down = database(fresh());
    await expect(submitPublish(down.db, provider([json(500, {})]).deps, USER, input)).rejects.toMatchObject({
      code: 'PUBLISH_MONITOR_PROVIDER_BUSY' });
    expect(down.names()).not.toContain('publish_monitor_publish_dispatch');
  });

  it('reports a deleted or re-owned account to the database, which decides; no post when it refuses', async () => {
    const d = database({ ...fresh(), publish_monitor_publish_dispatch: [{ ...view('released'), dispatch: false }] });
    const p = provider([json(404, {}), account('spc_y', 'c'.repeat(32))]);
    expect((await submitPublish(d.db, p.deps, USER, input)).state).toBe('released');
    expect(d.calls[2]![1]).toMatchObject({ p_observed: { spc_x: { ownerRef: null, connected: false },
      spc_y: { ownerRef: 'c'.repeat(32), connected: true } } });
    expect(p.calls.map(c => c.line)).not.toContain('POST /social-posts');
  });

  it('releases only on a definite refusal; anything else is unknown and is never resent', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const d = database(fresh());
      const p = provider([account('spc_x'), account('spc_y'), json(status, { error: ['bad'] })]);
      await submitPublish(d.db, p.deps, USER, input);
      expect(d.calls.at(-1)).toEqual(['publish_monitor_publish_release', { p_job: JOB,
        p_code: `PUBLISH_MONITOR_PROVIDER_REJECTED_${status}` }]);
    }
    for (const answer of [json(500, {}), json(502, {}), json(408, {}), json(409, {}), json(429, {}), new Error('reset'),
      json(200, { id: 'sp_1', external_id: 'someone-else' })]) {
      const d = database(fresh());
      const p = provider([account('spc_x'), account('spc_y'), answer]);
      await submitPublish(d.db, p.deps, USER, input);
      expect(d.calls.at(-1)).toEqual(['publish_monitor_publish_unknown', { p_job: JOB, p_code: 'PUBLISH_MONITOR_RESULT_UNKNOWN' }]);
      expect(p.calls.filter(c => c.line === 'POST /social-posts')).toHaveLength(1);
    }
  });

  it('maps database refusals to stable codes', async () => {
    for (const code of ['PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH', 'PUBLISH_MONITOR_QUOTA_EXHAUSTED',
      'PUBLISH_MONITOR_INSUFFICIENT_CREDITS', 'PUBLISH_MONITOR_TARGET_INVALID']) {
      const d = database({ publish_monitor_publish_claim: [new Error(`ERROR: ${code}`)] });
      await expect(submitPublish(d.db, provider([]).deps, USER, input)).rejects.toMatchObject({ code });
    }
  });
});

describe('reconcile publishes (simulated provider)', () => {
  const item = (action: 'release' | 'check', providerPostId: string | null = null) => ({ jobId: JOB, lease: LEASE, action,
    externalId: JOB, providerPostId, targets: [{ connectionId: CX, providerAccountId: 'spc_x' },
      { connectionId: CY, providerAccountId: 'spc_y' }] });

  it('releases expired claims and backs off when the post is not found yet (never treated as "not sent")', async () => {
    const d = database({ publish_monitor_publish_reconcile_claim: [[item('release'), item('check')]],
      publish_monitor_publish_release: [view('released')], publish_monitor_publish_check_later: [view('unknown')] });
    const p = provider([json(200, { data: [], meta: { total: 0 } })]);
    const report = await reconcilePublishes(d.db, p.deps, Date.now() + 60_000);
    expect(report).toEqual({ processed: 2, settled: 1, deferred: 1, manual: 0 });
    expect(d.calls[1]).toEqual(['publish_monitor_publish_release', { p_job: JOB, p_code: 'PUBLISH_MONITOR_CLAIM_EXPIRED' }]);
    expect(d.calls[2]).toEqual(['publish_monitor_publish_check_later', { p_job: JOB, p_lease: LEASE,
      p_code: 'PUBLISH_MONITOR_NOT_FOUND_YET' }]);
    expect(p.calls.map(c => c.line)).toEqual([`GET /social-posts?external_id=${JOB}&limit=2&offset=0`]);
  });

  it('finds the post by external_id and records per-target results with safe links only', async () => {
    const d = database({ publish_monitor_publish_reconcile_claim: [[item('check')]],
      publish_monitor_publish_record: [view('completed')], publish_monitor_publish_unlease: [null] });
    const p = provider([json(200, { data: [{ id: 'sp_9', external_id: JOB }] }),
      json(200, { data: [{ social_account_id: 'spc_x', post_id: 'sp_9', success: true,
        platform_data: { url: 'https://x.com/u/status/1' } },
      { social_account_id: 'spc_y', post_id: 'sp_9', success: false, platform_data: { url: 'http://insecure' } }] })]);
    const report = await reconcilePublishes(d.db, p.deps, Date.now() + 60_000);
    expect(report.settled).toBe(1);
    expect(d.calls[1]).toEqual(['publish_monitor_publish_record', { p_job: JOB, p_provider_post_id: 'sp_9',
      p_results: { [CX]: { status: 'published', url: 'https://x.com/u/status/1' }, [CY]: { status: 'failed' } } }]);
    expect(d.calls[2]![0]).toBe('publish_monitor_publish_unlease');
  });

  it('refuses to settle when two provider posts carry the same job id, and reports manual review', async () => {
    const d = database({ publish_monitor_publish_reconcile_claim: [[item('check')]],
      publish_monitor_publish_check_later: [{ ...view('unknown'), manualReview: true }] });
    const p = provider([json(200, { data: [{ id: 'sp_1', external_id: JOB }, { id: 'sp_2', external_id: JOB }] })]);
    const warn = vi.spyOn(logger, 'warn');
    expect(await reconcilePublishes(d.db, p.deps, Date.now() + 60_000)).toMatchObject({ manual: 1 });
    expect(d.calls[1]).toEqual(['publish_monitor_publish_check_later', { p_job: JOB, p_lease: LEASE,
      p_code: 'PUBLISH_MONITOR_CHECK_FAILED' }]);
    expect(warn).toHaveBeenCalledWith('api', 'publish_monitor_publish_manual_review', { jobId: JOB });
    warn.mockRestore();
  });

  it('does not start work after the deadline', async () => {
    const d = database({});
    expect(await reconcilePublishes(d.db, provider([]).deps, Date.now() - 1)).toEqual({ processed: 0, settled: 0,
      deferred: 0, manual: 0 });
    expect(d.calls).toEqual([]);
  });
});

describe('refresh publish job', () => {
  it('only open jobs reach the provider', async () => {
    const done = database({ publish_monitor_publish_job: [view('completed')] });
    const idle = provider([]);
    expect((await refreshPublishJob(done.db, idle.deps, USER, JOB)).state).toBe('completed');
    expect(idle.calls).toEqual([]);
    const open = database({ publish_monitor_publish_job: [view('unknown')],
      publish_monitor_publish_check_info: [{ jobId: JOB, providerPostId: 'sp_1', targets: [{ connectionId: CX,
        providerAccountId: 'spc_x' }] }], publish_monitor_publish_record: [view('unknown')] });
    const p = provider([json(200, { data: [] })]);
    await refreshPublishJob(open.db, p.deps, USER, JOB);
    expect(p.calls.map(c => c.line)).toEqual(['GET /social-post-results?post_id=sp_1&limit=50&offset=0']);
    expect(open.calls.at(-1)).toEqual(['publish_monitor_publish_record', { p_job: JOB, p_provider_post_id: 'sp_1',
      p_results: {} }]);
  });
});
