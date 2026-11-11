/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { ClientDeps } from './postForMe/client';
import { publishFingerprint, reconcilePublishes, submitPublish, type PublishInput } from './publish';
import { cancelScheduled, LOCK_MS, PREFLIGHT_MS, rescheduleScheduled, runScheduleChecks } from './schedule';

// PUBLISH-SCHEDULE. Simulated provider only: no request leaves the test and nothing is published.
const USER = '00000000-0000-4000-8000-00000000b001';
const JOB = '00000000-0000-4000-8000-00000000b002';
const BIZ = '00000000-0000-4000-8000-00000000b003';
const CX = '00000000-0000-4000-8000-00000000b004';
const LEASE = '00000000-0000-4000-8000-00000000b006';
const OTHER = '00000000-0000-4000-8000-00000000b007';
const MINE = 'a'.repeat(32);
const MEDIA = 'https://data.postforme.dev/storage/v1/object/public/post-media/secret-file.jpg';
const HOUR = 3600_000;
const AT = '2026-11-20T17:00:00.000Z';
const at = Date.parse(AT);
const input: PublishInput = {
  idempotencyKey: 'key-sched-001', businessId: BIZ, workItemId: null, connectionIds: [CX], caption: 'Hello schedule',
  maxHoldCredits: 6, media: [{ mediaUrl: MEDIA, sha256: 'f'.repeat(64), size: 1000, mimeType: 'image/jpeg' }],
  scheduledAt: '2026-11-20T09:00:00-08:00',
};
const view = (state: string, extra: Record<string, unknown> = {}) => ({ id: JOB, state, businessId: BIZ, workItemId: null,
  targets: [{ connectionId: CX, platform: 'x', status: 'pending', url: null }], holdCredits: 6, chargedCredits: null,
  manualReview: false, errorCode: null, createdAt: 'now', updatedAt: 'now', scheduledAt: AT, ...extra });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const account = (id: string) => json(200, { id, platform: 'x', status: 'connected', external_id: `${MINE}.${'b'.repeat(32)}` });
const post = (extra: Record<string, unknown> = {}) => json(200, { id: 'sp_1', external_id: JOB, caption: 'Hello schedule',
  status: 'scheduled', scheduled_at: AT, social_accounts: [{ id: 'spc_x', access_token: 'secret-token' }],
  media: [{ id: 'm1', url: MEDIA, thumbnail_url: null, provider: null }], platform_configurations: null,
  account_configurations: null, ...extra });

function provider(responses: Array<Response | Error>) {
  const calls: Array<{ line: string; body: unknown }> = [];
  const deps: ClientDeps = { apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async (url, init) => {
      calls.push({ line: `${init.method} ${url.replace(/^.*\/v1/, '')}`, body: init.body ? JSON.parse(String(init.body)) : null });
      const next = responses.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no response');
      return next;
    } };
  return { deps, calls, lines: () => calls.map(c => c.line) };
}
function database(results: Record<string, unknown[]>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, names: () => calls.map(c => c[0]), last: (name: string) => calls.filter(c => c[0] === name).at(-1)?.[1],
    db: { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      const queue = results[name] ?? [];
      const next = queue.length ? queue.shift() : null;
      if (next instanceof Error) return { data: null, error: { message: next.message } };
      return { data: next, error: null };
    } } as never };
}
const submitDb = (extra: Record<string, unknown[]> = {}) => database({
  publish_monitor_publish_claim: [{ ...view('claimed'), replayed: false }],
  publish_monitor_schedule_prepare: [view('claimed')],
  publish_monitor_publish_targets: [{ providerAccountIds: ['spc_x'] }],
  publish_monitor_publish_dispatch: [{ ...view('dispatching'), dispatch: true, providerAccountIds: ['spc_x'] }],
  publish_monitor_schedule_accepted: [{ ...view('scheduled'), accepted: true }],
  publish_monitor_publish_record: [view('unknown')], publish_monitor_publish_release: [view('released')], ...extra });

describe('scheduled publish submit', () => {
  it('binds the scheduled instant to the key; offsets of one instant are one request; no time keeps the old print', () => {
    const now = { ...input, scheduledAt: undefined };
    expect(publishFingerprint(input)).not.toBe(publishFingerprint(now));
    expect(publishFingerprint(input)).toBe(publishFingerprint({ ...input, scheduledAt: AT }));
    expect(publishFingerprint(input)).not.toBe(publishFingerprint({ ...input, scheduledAt: '2026-11-20T17:01:00Z' }));
    expect(publishFingerprint(now)).toBe(publishFingerprint({ ...now }));
  });

  it('prepares the time in UTC before sending, creates one post with scheduled_at, and waits as scheduled', async () => {
    const d = submitDb();
    const p = provider([account('spc_x'), json(200, { id: 'sp_1', external_id: JOB, status: 'scheduled' })]);
    const job = await submitPublish(d.db, p.deps, USER, input);
    expect(job.state).toBe('scheduled');
    expect(d.last('publish_monitor_schedule_prepare')).toEqual({ a: USER, p_job: JOB, p_scheduled_at: AT,
      p_preview: 'Hello schedule', p_media_count: 1 });
    expect(d.names().indexOf('publish_monitor_schedule_prepare')).toBeLessThan(d.names().indexOf('publish_monitor_publish_dispatch'));
    expect(p.calls.filter(c => c.line === 'POST /social-posts')).toHaveLength(1);
    expect(p.calls.at(-1)!.body).toMatchObject({ scheduled_at: AT, external_id: JOB });
    expect(d.names()).toContain('publish_monitor_schedule_accepted');
    expect(d.names()).not.toContain('publish_monitor_publish_record');
  });

  it('keeps only 40 characters of the caption for the schedule view, never splitting a character', async () => {
    const d = submitDb();
    const p = provider([account('spc_x'), json(200, { id: 'sp_1', external_id: JOB, status: 'scheduled' })]);
    await submitPublish(d.db, p.deps, USER, { ...input, caption: `${'😀'.repeat(39)}ab tail that is never stored` });
    expect(d.last('publish_monitor_schedule_prepare')!.p_preview).toBe(`${'😀'.repeat(39)}a`);
  });

  it('a time the database refuses releases the hold at once; nothing reaches the provider', async () => {
    const d = submitDb({ publish_monitor_schedule_prepare: [new Error('ERROR: PUBLISH_SCHEDULE_TIME_INVALID')] });
    const p = provider([]);
    await expect(submitPublish(d.db, p.deps, USER, input)).rejects.toMatchObject({ code: 'PUBLISH_SCHEDULE_TIME_INVALID' });
    expect(d.last('publish_monitor_publish_release')).toEqual({ p_job: JOB, p_code: 'PUBLISH_SCHEDULE_TIME_INVALID' });
    expect(p.calls).toEqual([]);
  });

  it('a create Post for Me reports as already sending is reconciled as a sent post', async () => {
    const d = submitDb();
    const p = provider([account('spc_x'), json(200, { id: 'sp_1', external_id: JOB, status: 'processing' })]);
    await submitPublish(d.db, p.deps, USER, input);
    expect(d.names()).toContain('publish_monitor_publish_record');
    expect(d.names()).not.toContain('publish_monitor_schedule_accepted');
  });

  it('after an unknown create, finding the post scheduled moves the job to waiting (not to manual review)', async () => {
    const d = database({ publish_monitor_publish_reconcile_claim: [[{ jobId: JOB, lease: LEASE, action: 'check',
      externalId: JOB, providerPostId: null, targets: [{ connectionId: CX, providerAccountId: 'spc_x' }] }]],
    publish_monitor_schedule_accepted: [{ ...view('scheduled'), accepted: true }] });
    const p = provider([json(200, { data: [{ id: 'sp_1', external_id: JOB, status: 'scheduled' }] })]);
    const report = await reconcilePublishes(d.db, p.deps, Date.now() + 60_000);
    expect(report).toMatchObject({ processed: 1, settled: 1 });
    expect(p.lines()).toEqual([`GET /social-posts?external_id=${JOB}&limit=2&offset=0`]);
    expect(d.names()).not.toContain('publish_monitor_publish_check_later');
  });
});

const begun = (extra: Record<string, unknown> = {}) => ({ ...view('scheduled'), lease: LEASE, providerPostId: 'sp_1',
  mediaCount: 1, providerAccountIds: ['spc_x'], ...extra });

describe('cancel a scheduled post', () => {
  const run = async (answer: Response | Error, extra: Record<string, unknown[]> = {}) => {
    const d = database({ publish_monitor_schedule_begin: [begun()], publish_monitor_schedule_finish: [view('released')], ...extra });
    const p = provider([answer]);
    await cancelScheduled(d.db, p.deps, USER, JOB, AT);
    return { d, p, finish: d.last('publish_monitor_schedule_finish') };
  };

  it('deletes the provider post and releases the job; a post already gone counts as cancelled', async () => {
    for (const answer of [json(200, { success: true }), json(404, {})]) {
      const { p, finish } = await run(answer);
      expect(p.lines()).toEqual(['DELETE /social-posts/sp_1']);
      expect(finish).toMatchObject({ p_job: JOB, p_lease: LEASE, p_outcome: 'cancelled' });
    }
  });

  it('sending already started: reconciled as sent (the database keeps the cancel, so it is not charged)', async () => {
    expect((await run(json(400, { message: 'Can only delete scheduled or draft posts' }))).finish)
      .toMatchObject({ p_outcome: 'started' });
  });

  it('no definite answer: recorded as pending, the cron step retries; never reported as cancelled', async () => {
    for (const answer of [json(500, {}), new Error('reset'), json(200, { success: false })]) {
      expect((await run(answer)).finish).toMatchObject({ p_outcome: 'kept', p_code: 'PUBLISH_SCHEDULE_CANCEL_PENDING' });
    }
  });

  it('a second cancel while one is pending does not call the provider again', async () => {
    const d = database({ publish_monitor_schedule_begin: [begun({ lease: null, cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' })] });
    const p = provider([]);
    await cancelScheduled(d.db, p.deps, USER, JOB, AT);
    expect(p.calls).toEqual([]);
    expect(d.names()).toEqual(['publish_monitor_schedule_begin']);
  });

  it('passes database refusals through (changed in another tab, locked, busy)', async () => {
    for (const code of ['PUBLISH_SCHEDULE_CHANGED', 'PUBLISH_SCHEDULE_LOCKED', 'PUBLISH_SCHEDULE_BUSY']) {
      const d = database({ publish_monitor_schedule_begin: [new Error(`ERROR: ${code}`)] });
      await expect(cancelScheduled(d.db, provider([]).deps, USER, JOB, AT)).rejects.toMatchObject({ code });
    }
  });
});

describe('reschedule a scheduled post', () => {
  const NEW = '2026-11-21T17:00:00.000Z';
  const run = (answers: Array<Response | Error>, extra: Record<string, unknown[]> = {}) => {
    const d = database({ publish_monitor_schedule_begin: [begun()], publish_monitor_schedule_finish: [view('scheduled')],
      publish_monitor_publish_unlease: [null], ...extra });
    const p = provider(answers);
    return { d, p, done: rescheduleScheduled(d.db, p.deps, USER, JOB, AT, NEW) };
  };

  it('reads the post, sends it back whole with the new time, and records the move', async () => {
    const { d, p, done } = run([post(), post({ scheduled_at: NEW })]);
    await done;
    expect(p.lines()).toEqual(['GET /social-posts/sp_1', 'PUT /social-posts/sp_1']);
    expect(p.calls[1]!.body).toEqual({ caption: 'Hello schedule', social_accounts: ['spc_x'], external_id: JOB,
      scheduled_at: NEW, media: [{ url: MEDIA }] });
    expect(JSON.stringify(p.calls[1]!.body)).not.toContain('secret-token');
    expect(d.last('publish_monitor_schedule_finish')).toMatchObject({ p_outcome: 'moved', p_at: NEW });
  });

  it('a post that is not what Graylum sent is never moved; the cron step verifies it', async () => {
    for (const changed of [post({ social_accounts: ['spc_x', 'spc_z'] }), post({ media: [] }), post({ scheduled_at: NEW }),
      post({ platform_configurations: { x: { caption: 'other' } } })]) {
      const { d, p, done } = run([changed]);
      await expect(done).rejects.toMatchObject({ code: 'PUBLISH_SCHEDULE_PROVIDER_CHANGED' });
      expect(p.lines()).toEqual(['GET /social-posts/sp_1']);
      expect(d.last('publish_monitor_schedule_finish')).toMatchObject({ p_outcome: 'kept', p_code: 'PUBLISH_SCHEDULE_VERIFY' });
    }
  });

  it('a post already sending is not touched', async () => {
    const { d, p, done } = run([post({ status: 'processing' })]);
    await expect(done).rejects.toMatchObject({ code: 'PUBLISH_SCHEDULE_LOCKED' });
    expect(p.lines()).toEqual(['GET /social-posts/sp_1']);
    expect(d.last('publish_monitor_schedule_finish')).toMatchObject({ p_outcome: 'started' });
  });

  it('a refused update changes nothing; an unproven one is verified later; a missing post is cancelled', async () => {
    const refused = run([post(), json(400, { errors: ['scheduled_at must be in the future'] })]);
    await expect(refused.done).rejects.toMatchObject({ code: 'PUBLISH_SCHEDULE_TIME_INVALID' });
    expect(refused.d.names()).toContain('publish_monitor_publish_unlease');
    expect(refused.d.names()).not.toContain('publish_monitor_schedule_finish');
    for (const answer of [json(500, {}), new Error('reset'), post({ scheduled_at: AT })]) {
      const unproven = run([post(), answer]);
      await unproven.done;
      expect(unproven.d.last('publish_monitor_schedule_finish')).toMatchObject({ p_outcome: 'kept',
        p_code: 'PUBLISH_SCHEDULE_VERIFY' });
    }
    const gone = run([post(), json(404, {})]);
    await expect(gone.done).rejects.toMatchObject({ code: 'PUBLISH_SCHEDULE_PROVIDER_CHANGED' });
    expect(gone.d.last('publish_monitor_schedule_finish')).toMatchObject({ p_outcome: 'cancelled',
      p_code: 'PUBLISH_SCHEDULE_PROVIDER_DELETED' });
  });
});

describe('schedule checks (cron step)', () => {
  const item = (extra: Record<string, unknown> = {}) => ({ jobId: JOB, lease: LEASE, actorId: USER, providerPostId: 'sp_1',
    scheduledAt: AT, mediaCount: 1, cancelReason: null, preflightDone: false, providerAccountIds: ['spc_x'], ...extra });
  const check = async (items: unknown[], answers: Array<Response | Error>, nowMs: number,
    allowed: (actorId: string) => Promise<boolean | null> = async () => true) => {
    const d = database({ publish_monitor_schedule_claim: [items], publish_monitor_schedule_finish: Array(10).fill(view('scheduled')),
      publish_monitor_publish_unlease: Array(10).fill(null) });
    const p = provider(answers);
    const report = await runScheduleChecks(d.db, p.deps, allowed, nowMs + 60_000, () => nowMs);
    return { d, p, report, finishes: d.calls.filter(c => c[0] === 'publish_monitor_schedule_finish').map(c => c[1]) };
  };

  it('a cancel request before the lock window deletes the post and releases the job', async () => {
    const r = await check([item({ cancelReason: 'PUBLISH_SCHEDULE_CANCELLED' })], [post(), json(200, { success: true })], at - HOUR);
    expect(r.p.lines()).toEqual(['GET /social-posts/sp_1', 'DELETE /social-posts/sp_1']);
    expect(r.finishes).toEqual([expect.objectContaining({ p_outcome: 'cancelled', p_code: 'PUBLISH_SCHEDULE_CANCELLED' })]);
  });

  it('inside the lock window nothing is deleted; the reason is kept so a post sent anyway is not charged', async () => {
    const r = await check([item({ cancelReason: 'PUBLISH_SCHEDULE_TARGET_CHANGED' })], [post()], at - LOCK_MS + 1000);
    expect(r.p.lines()).toEqual(['GET /social-posts/sp_1']);
    expect(r.finishes).toEqual([expect.objectContaining({ p_outcome: 'mark', p_code: 'PUBLISH_SCHEDULE_TARGET_CHANGED' })]);
  });

  it('40 minutes before the time: an ended membership cancels and refunds, a current one passes the check', async () => {
    const ended = await check([item()], [post(), json(200, { success: true })], at - PREFLIGHT_MS + 1000, async () => false);
    expect(ended.finishes).toEqual([expect.objectContaining({ p_outcome: 'cancelled', p_code: 'PUBLISH_SCHEDULE_MEMBERSHIP_ENDED' })]);
    const ok = await check([item()], [post()], at - PREFLIGHT_MS + 1000);
    expect(ok.finishes).toEqual([expect.objectContaining({ p_outcome: 'checked', p_at: new Date(at + 5 * 60_000).toISOString() })]);
    const unreadable = await check([item()], [post()], at - PREFLIGHT_MS + 1000, async () => null);
    expect(unreadable.finishes).toEqual([expect.objectContaining({ p_outcome: 'later' })]);
    expect(unreadable.p.lines()).not.toContain('DELETE /social-posts/sp_1');
  });

  it('reads the plan once per user per run', async () => {
    let reads = 0;
    const other = item({ jobId: OTHER, providerPostId: 'sp_2' });
    await check([item(), other], [post(), post({ id: 'sp_2' })], at - PREFLIGHT_MS + 1000, async () => { reads += 1; return true; });
    expect(reads).toBe(1);
  });

  it('a post already sending goes to reconciliation; one gone before its time is released', async () => {
    const sending = await check([item({ preflightDone: true })], [post({ status: 'processed' })], at + 60_000);
    expect(sending.finishes).toEqual([expect.objectContaining({ p_outcome: 'started' })]);
    const gone = await check([item()], [json(404, {})], at - 2 * HOUR);
    expect(gone.finishes).toEqual([expect.objectContaining({ p_outcome: 'cancelled', p_code: 'PUBLISH_SCHEDULE_PROVIDER_DELETED' })]);
  });

  it('adopts the time Post for Me has after an unverified reschedule; cancels a post whose content changed', async () => {
    const NEW = '2026-11-21T17:00:00.000Z';
    const moved = await check([item()], [post({ scheduled_at: NEW })], at - 5 * HOUR);
    expect(moved.finishes).toEqual([expect.objectContaining({ p_outcome: 'moved', p_at: NEW })]);
    const changed = await check([item()], [post({ media: [] }), json(200, { success: true })], at - 5 * HOUR);
    expect(changed.finishes).toEqual([expect.objectContaining({ p_outcome: 'cancelled',
      p_code: 'PUBLISH_SCHEDULE_PROVIDER_CHANGED' })]);
  });

  it('far from the time it only schedules the next check; nothing is called after the deadline', async () => {
    const far = await check([item()], [post()], at - 5 * HOUR);
    expect(far.finishes).toEqual([expect.objectContaining({ p_outcome: 'kept', p_at: new Date(at - PREFLIGHT_MS).toISOString() })]);
    const d = database({ publish_monitor_schedule_claim: [[item()]], publish_monitor_publish_unlease: [null] });
    const p = provider([]);
    const report = await runScheduleChecks(d.db, p.deps, async () => true, 0, () => 1);
    expect(report.stopped).toBeUndefined();
    expect(p.calls).toEqual([]);
  });

  it('the shared provider budget spent: the job and the rest are handed back unchanged', async () => {
    const d = database({ publish_monitor_schedule_claim: [[item(), item({ jobId: OTHER })]],
      publish_monitor_publish_unlease: [null, null] });
    const p = provider([json(429, {})]);
    const report = await runScheduleChecks(d.db, p.deps, async () => true, at, () => at - HOUR);
    expect(report.stopped).toBe('provider_busy');
    expect(d.calls.filter(c => c[0] === 'publish_monitor_publish_unlease').map(c => c[1].p_job)).toEqual([JOB, OTHER]);
    expect(d.names()).not.toContain('publish_monitor_schedule_finish');
  });
});
