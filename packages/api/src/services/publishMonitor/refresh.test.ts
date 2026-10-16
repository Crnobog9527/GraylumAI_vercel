/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { ClientDeps } from './postForMe/client';
import { pruneSnapshots, refreshConnection, runRefresh, type RefreshClaim } from './refresh';

const OWNER = 'a'.repeat(32);
const NOW = Date.parse('2026-10-17T12:00:00Z');
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW - offsetDays * day).toISOString();
const claim = (over: Partial<RefreshClaim> = {}): RefreshClaim => ({
  connectionId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222',
  lease: '33333333-3333-4333-8333-333333333333', refreshId: '44444444-4444-4444-8444-444444444444', cursor: null,
  providerAccountId: 'spc_1', platform: 'youtube', ownerRef: OWNER, pagesUsed: 0, knownPosts: 0, ...over,
});
const post = (id: string, ageDays: number | null) => ({ platform_post_id: id, posted_at: ageDays === null ? null : iso(ageDays),
  caption: `post ${id}`, metrics: { views: 10 } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const account = (externalId = `${OWNER}.${'b'.repeat(32)}`, status = 'connected') =>
  json(200, { id: 'spc_1', platform: 'youtube', status, external_id: externalId });

type Page = { status?: number; posts?: unknown[]; cursor?: string | null };
function provider(pages: Page[], accountResponse: () => Response = () => account(), ignoreIdFilter = false) {
  const urls: string[] = [];
  const deps: ClientDeps = { apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async input => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/social-accounts/')) return accountResponse();
      const params = new URL(url).searchParams;
      const ids = params.getAll('platform_post_id');
      if (ids.length && !ignoreIdFilter) {
        // Like Facebook with metrics: at most 10 posts per filtered page, then a cursor.
        const offset = Number(params.get('cursor')?.replace('ids', '') ?? 0);
        const slice = ids.slice(offset, offset + 10);
        const more = offset + 10 < ids.length;
        return json(200, { data: slice.map(id => post(id, 2)), meta: { has_more: more, cursor: more ? `ids${offset + 10}` : null } });
      }
      const page = pages.shift() ?? { posts: [] };
      if (page.status) return json(page.status, { error: 'x' });
      return json(200, { data: page.posts ?? [], meta: { cursor: page.cursor ?? null, has_more: Boolean(page.cursor) } });
    } };
  return { deps, urls };
}

/** In-memory stand-in for the refresh RPCs: records writes, answers the existing/due questions. */
function database(opts: { known?: string[]; due?: string[]; stale?: boolean } = {}) {
  const known = new Set(opts.known ?? []);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return { calls, db: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'publish_monitor_refresh_page') {
        if (opts.stale) return { data: { stale: true }, error: null };
        let inserted = 0, existing = 0;
        for (const p of args.p_posts as Array<{ platformPostId: string }>) {
          if (known.has(p.platformPostId)) existing += 1; else { inserted += 1; known.add(p.platformPostId); }
        }
        return { data: { stale: false, inserted, existing }, error: null };
      }
      if (name === 'publish_monitor_refresh_due') return { data: opts.due ?? [], error: null };
      if (name === 'publish_monitor_refresh_finish') return { data: true, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  } as never };
}
const finished = (calls: ReturnType<typeof database>['calls']) =>
  calls.filter(c => c.name === 'publish_monitor_refresh_finish').map(c => [c.args.p_outcome, c.args.p_error]);
const run = (db: ReturnType<typeof database>, deps: ClientDeps, over: Partial<RefreshClaim> = {}, cap = 10, window = 30) =>
  refreshConnection(db.db, deps, claim(over), window, cap, NOW + 60_000, () => NOW);

describe('publish-monitor refresh of one connection', () => {
  it('checks the owner reference first: another user\'s reference is a takeover and nothing is read', async () => {
    const db = database();
    const p = provider([{ posts: [post('v1', 1)] }], () => account(`${'c'.repeat(32)}.${'d'.repeat(32)}`));
    expect((await run(db, p.deps)).outcome).toBe('taken_over');
    expect(p.urls.some(u => u.includes('/social-account-feeds/'))).toBe(false);
    expect(db.calls.some(c => c.name === 'publish_monitor_refresh_page')).toBe(false);
  });

  it('a disconnected provider account asks for re-authorisation; a 5xx is "not fetched", never a deletion', async () => {
    const off = database();
    await run(off, provider([], () => account(undefined, 'disconnected')).deps);
    expect(finished(off.calls)).toEqual([['rejected', 'PROVIDER_DISCONNECTED']]);
    const down = database();
    await run(down, provider([{ status: 500 }]).deps);
    expect(finished(down.calls)).toEqual([['failed', 'PROVIDER_FAILED_500']]);
    // The failed read still counts against the persistent daily cap.
    expect(down.calls.filter(c => c.name === 'publish_monitor_refresh_page').map(c => c.args.p_posts)).toEqual([[]]);
    const busy = database();
    await run(busy, provider([{ status: 429 }]).deps);
    expect(finished(busy.calls)).toEqual([['release', 'PROVIDER_BUSY']]);
    expect(busy.calls.some(c => c.name === 'publish_monitor_refresh_page')).toBe(false);
  });

  it('an empty first page counts against the daily cap and is reported as empty for the database rules', async () => {
    const db = database();
    expect((await run(db, provider([{ posts: [] }]).deps)).outcome).toBe('empty');
    const pages = db.calls.filter(c => c.name === 'publish_monitor_refresh_page');
    expect(pages.map(c => [c.args.p_posts, c.args.p_save_cursor])).toEqual([[[], false]]);
  });

  it('ownership is checked again after every read: a takeover mid-refresh stores nothing from that page', async () => {
    const db = database();
    let reads = 0;
    const p = provider([{ posts: [post('a', 1)], cursor: 'c2' }, { posts: [post('theirs', 1)], cursor: 'c3' }],
      () => (reads++ < 2 ? account() : account(`${'c'.repeat(32)}.${'d'.repeat(32)}`)));
    expect((await run(db, p.deps)).outcome).toBe('taken_over');
    const written = db.calls.filter(c => c.name === 'publish_monitor_refresh_page')
      .flatMap(c => (c.args.p_posts as Array<{ platformPostId: string }>).map(x => x.platformPostId));
    expect(written).toEqual(['a']);
  });

  it('a platform that ignores the post-ID filter is paged through until every due post was seen', async () => {
    const db = database({ known: ['k'], due: ['old1', 'old2'] });
    const p = provider([{ posts: [post('k', 1)] }, { posts: [post('k', 1)], cursor: 'f2' },
      { posts: [post('old1', 10)], cursor: 'f3' }, { posts: [post('old2', 20)], cursor: 'f4' }, { posts: [post('never', 25)] }],
    undefined, true);
    expect((await run(db, p.deps)).outcome).toBe('done');
    const feeds = p.urls.filter(u => u.includes('/social-account-feeds/'));
    expect(feeds.length).toBe(4);
    const written = db.calls.filter(c => c.name === 'publish_monitor_refresh_page')
      .flatMap(c => (c.args.p_posts as Array<{ platformPostId: string }>).map(x => x.platformPostId));
    expect(written).toEqual(expect.arrayContaining(['old1', 'old2']));
  });

  it('discovery stops at the first page holding a known post and saves the cursor with each page', async () => {
    const db = database({ known: ['old'] });
    const p = provider([{ posts: [post('n1', 0), post('n2', 1)], cursor: 'c2' }, { posts: [post('n3', 2), post('old', 3)],
      cursor: 'c3' }, { posts: [post('never', 4)] }]);
    const result = await run(db, p.deps);
    expect([result.outcome, result.inserted, result.pages]).toEqual(['done', 3, 2]);
    const pages = db.calls.filter(c => c.name === 'publish_monitor_refresh_page');
    expect(pages.map(c => c.args.p_cursor)).toEqual(['c2', 'c3']);
  });

  it('posts older than the window are not stored and stop discovery', async () => {
    const db = database();
    const p = provider([{ posts: [post('in', 5), post('out', 40)], cursor: 'c2' }, { posts: [post('older', 50)], cursor: 'c3' },
      { posts: [post('never', 60)] }]);
    await run(db, p.deps);
    const written = db.calls.filter(c => c.name === 'publish_monitor_refresh_page')
      .flatMap(c => (c.args.p_posts as Array<{ platformPostId: string }>).map(x => x.platformPostId));
    expect(written).toEqual(['in']);
    expect(p.urls.filter(u => u.includes('/social-account-feeds/')).length).toBe(2);
  });

  it('the daily page cap is shared with earlier reads today; reaching it settles as partial with the cursor kept', async () => {
    const db = database();
    const p = provider([{ posts: [post('a', 1)], cursor: 'c2' }, { posts: [post('b', 2)], cursor: 'c3' }]);
    const result = await run(db, p.deps, { pagesUsed: 8 });
    expect(result.outcome).toBe('partial');
    expect(finished(db.calls)).toEqual([['partial', 'PAGE_CAP']]);
    expect(p.urls.filter(u => u.includes('/social-account-feeds/')).length).toBe(2);
  });

  it('a resumed refresh continues from its saved cursor; a cursor the provider refuses restarts from the newest page', async () => {
    const db = database();
    const p = provider([{ posts: [post('r', 3)] }]);
    await run(db, p.deps, { cursor: 'saved' });
    expect(p.urls.find(u => u.includes('/social-account-feeds/'))).toContain('cursor=saved');
    const retry = database();
    const q = provider([{ status: 400 }, { posts: [post('fresh', 1)] }]);
    expect((await run(retry, q.deps, { cursor: 'expired' })).outcome).toBe('done');
    const feeds = q.urls.filter(u => u.includes('/social-account-feeds/'));
    expect([feeds[0]!.includes('cursor=expired'), feeds[1]!.includes('cursor=')]).toEqual([true, false]);
    // The refused cursor is cleared in the database together with counting that read.
    const first = retry.calls.find(c => c.name === 'publish_monitor_refresh_page')!;
    expect([first.args.p_posts, first.args.p_cursor, first.args.p_save_cursor]).toEqual([[], null, true]);
  });

  it('known posts due today are read by ID in batches after discovery', async () => {
    const due = Array.from({ length: 25 }, (_, i) => `due${i}`);
    const db = database({ known: ['k'], due });
    const p = provider([{ posts: [post('k', 1)] }]);
    expect((await run(db, p.deps)).outcome).toBe('done');
    const batches = p.urls.filter(u => u.includes('platform_post_id'));
    // A filtered answer paged at 10 is followed until every asked post was seen.
    expect(batches.map(u => new URL(u).searchParams.getAll('platform_post_id').length)).toEqual([20, 20, 5]);
    const written = db.calls.filter(c => c.name === 'publish_monitor_refresh_page')
      .flatMap(c => (c.args.p_posts as Array<{ platformPostId: string }>).map(x => x.platformPostId));
    expect(due.every(id => written.includes(id))).toBe(true);
  });

  it('a page whose ownership re-check fails is still counted against the daily cap', async () => {
    const db = database();
    let reads = 0;
    const p = provider([{ posts: [post('a', 1)] }], () => (reads++ < 1 ? account() : json(500, { error: 'x' })));
    expect((await run(db, p.deps)).outcome).toBe('failed');
    expect(db.calls.filter(c => c.name === 'publish_monitor_refresh_page').map(c => c.args.p_posts)).toEqual([[]]);
  });

  it('a claim taken over by someone else stops without settling', async () => {
    const db = database({ stale: true });
    expect((await run(db, provider([{ posts: [post('x', 1)] }]).deps)).outcome).toBe('stale');
    expect(finished(db.calls)).toEqual([]);
  });

  it('a page whose every entry is unreadable is counted and settled as failed, never as success', async () => {
    const db = database();
    await run(db, provider([{ posts: [{ bogus: true }, { platform_post_id: '' }] }]).deps);
    expect(finished(db.calls)).toEqual([['failed', 'PROVIDER_RESPONSE_SHAPE']]);
    expect(db.calls.filter(c => c.name === 'publish_monitor_refresh_page').map(c => c.args.p_posts)).toEqual([[]]);
  });

  it('retention drains expired snapshots in batches until fewer than a batch remain', async () => {
    const left = [20_000, 20_000, 7];
    const rpc = async () => ({ data: left.shift() ?? 0, error: null });
    expect(await pruneSnapshots({ rpc } as never, NOW + 60_000, () => NOW)).toBe(40_007);
  });

  it('a missing owner reference never reads', async () => {
    const db = database();
    const p = provider([]);
    await run(db, p.deps, { ownerRef: null });
    expect(finished(db.calls)).toEqual([['failed', 'OWNER_REF_MISSING']]);
    expect(p.urls).toEqual([]);
  });
});

describe('publish-monitor daily refresh step', () => {
  function jobDb(batches: RefreshClaim[][]) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return { calls, db: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'publish_monitor_refresh_claim') return { data: batches.shift() ?? [], error: null };
        if (name === 'publish_monitor_refresh_finish') return { data: true, error: null };
        if (name === 'publish_monitor_refresh_page') return { data: { stale: false, inserted: 1, existing: 0 }, error: null };
        if (name === 'publish_monitor_refresh_due') return { data: [], error: null };
        return { data: null, error: { message: 'unexpected' } };
      },
      from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }),
    } as never };
  }

  it('a plan without a data window is settled without any provider call; the entitlement is read once per user', async () => {
    const a = claim(), b = claim({ connectionId: '55555555-5555-4555-8555-555555555555' });
    const db = jobDb([[a, b]]);
    const p = provider([]);
    let lookups = 0;
    const report = await runRefresh(db.db, p.deps, async () => { lookups += 1; return 0; }, NOW + 60_000, () => NOW);
    expect(report.outcomes).toEqual({ entitlement: 2 });
    expect([lookups, p.urls.length]).toEqual([1, 0]);
  });

  it('a rate-limited read releases the rest of the batch and ends the step', async () => {
    const a = claim(), b = claim({ connectionId: '55555555-5555-4555-8555-555555555555' });
    const db = jobDb([[a, b], [claim()]]);
    const p = provider([{ status: 429 }]);
    const report = await runRefresh(db.db, p.deps, async () => 30, NOW + 60_000, () => NOW);
    expect(report.outcomes).toEqual({ release: 2 });
    expect(db.calls.filter(c => c.name === 'publish_monitor_refresh_claim').length).toBe(1);
  });

  it('an unreadable entitlement leaves the connection for the next run instead of guessing', async () => {
    const db = jobDb([[claim()], [claim()]]);
    const report = await runRefresh(db.db, provider([]).deps, async () => { throw new Error('down'); }, NOW + 60_000,
      () => NOW);
    expect(report.outcomes).toEqual({ release: 1 });
  });
});
