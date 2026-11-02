/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { computeVersionMarks, loadVersionMarks, TRACE_LIMIT, VersionMarksDenied, type ReviewRow, type VersionRow } from './versionMarks';

const v = (id: string, source: string | null = null, from: string | null = null): VersionRow => ({ id, source, from });
const done = (id: string, source: string, patch: Partial<ReviewRow> = {}): ReviewRow => ({ id, draft_id: 'd1', source_version_id: source, state: 'completed',
  ended_at: '2026-10-19T10:00:00Z', adoption: null, ...patch });

describe('version marks', () => {
  it('marks a version reviewed once a review of it completed, even when no revision was adopted or none was changed', () => {
    const marks = computeVersionMarks([v('a')], [done('r1', 'a', { adoption: { state: 'recorded', versionId: null, adopted: [] } })]);
    expect(marks.a).toMatchObject({ mark: 'reviewed', reviewId: 'r1', draftId: 'd1', adoptedCount: 0 });
    expect(computeVersionMarks([v('a')], [done('r2', 'a')]).a).toMatchObject({ mark: 'reviewed', adoptedCount: 0 });
  });

  it('does not count a failed, stopped or unfinished review', () => {
    for (const state of ['revision_failed', 'incomplete', 'stopped', 'interrupted', 'running', 'paused']) {
      expect(computeVersionMarks([v('a')], [done('r', 'a', { state })])).toEqual({});
    }
  });

  it('marks the version an adoption produced as reviewed, with the number of adopted chapters', () => {
    const marks = computeVersionMarks([v('a'), v('b', 'review_revision', 'a')],
      [done('r', 'a', { adoption: { state: 'recorded', versionId: 'b', adopted: ['一', '二', '三'], at: '2026-10-19T11:00:00Z' } })]);
    expect(marks.b).toMatchObject({ mark: 'reviewed', reviewId: 'r', adoptedCount: 3, reviewedAt: '2026-10-19T11:00:00Z' });
    expect(marks.a).toMatchObject({ mark: 'reviewed', adoptedCount: 3 });
  });

  it('marks an edit of a reviewed version derived, all the way up, until it is itself reviewed', () => {
    const versions = [v('a'), v('b', 'review_revision', 'a'), v('c', 'review_revision', 'b'), v('d', 'review_revision', 'c')];
    const adoption = done('r', 'a', { adoption: { state: 'recorded', versionId: 'b', adopted: ['一'] } });
    const marks = computeVersionMarks(versions, [adoption]);
    expect(marks.c).toMatchObject({ mark: 'derived', derivedFrom: 'b' });
    expect(marks.d).toMatchObject({ mark: 'derived', derivedFrom: 'b' });
    // Once d is reviewed it is reviewed, not derived.
    expect(computeVersionMarks(versions, [adoption, done('r2', 'd')]).d).toMatchObject({ mark: 'reviewed', reviewId: 'r2' });
  });

  it('marks nothing on an ordinary report, a manual edit of one, or an edit that traces to no reviewed version', () => {
    expect(computeVersionMarks([v('a'), v('m', null, null)], [])).toEqual({});
    expect(computeVersionMarks([v('a'), v('b', 'review_revision', 'a')], [])).toEqual({});
    expect(computeVersionMarks([v('b', 'review_revision', 'gone')], [])).toEqual({});
  });

  it('never loops and never goes deeper than the limit', () => {
    expect(computeVersionMarks([v('a', 'review_revision', 'b'), v('b', 'review_revision', 'a')], [])).toEqual({});
    expect(computeVersionMarks([v('a', 'review_revision', 'a')], [])).toEqual({});
    const chain = Array.from({ length: TRACE_LIMIT + 5 }, (_, i) => v(`v${i}`, 'review_revision', `v${i + 1}`));
    const last = `v${TRACE_LIMIT + 5}`;
    const marks = computeVersionMarks([...chain, v(last)], [done('r', last)]);
    expect(marks.v0).toBeUndefined();
    expect(marks[`v${TRACE_LIMIT + 4}`]).toMatchObject({ mark: 'derived' });
  });
});

describe('loading version marks', () => {
  const draft = '10000000-0000-4000-8000-000000000001', mine = 'u1';
  const rpc = (result: { data?: unknown; error?: { message: string } | null }, calls: unknown[] = []) =>
    ({ rpc: (name: string, args: unknown) => { calls.push({ name, args }); return Promise.resolve({ data: null, error: null, ...result }); } }) as never;
  const rows = { versions: [v('a')], reviews: [done('r', 'a')] };

  it('answers for the caller\'s own analyses, reading through the database function and never a table', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const marks = await loadVersionMarks(rpc({ data: rows }, calls), mine, [draft, draft], ['a', 'a']);
    expect(marks.a).toMatchObject({ mark: 'reviewed' });
    expect(calls).toEqual([{ name: 'fusion_version_marks_read', args: { p_actor_id: mine, p_draft_ids: [draft], p_version_ids: ['a'] } }]);
    const noTable = { from: () => { throw new Error('a table was read directly'); }, rpc: (rpc({ data: rows }) as unknown as { rpc: unknown }).rpc } as never;
    expect((await loadVersionMarks(noTable, mine, [draft])).a).toMatchObject({ mark: 'reviewed' });
  });

  it('refuses another user\'s analysis, and an unknown one, instead of answering empty', async () => {
    await expect(loadVersionMarks(rpc({ error: { message: 'FUSION_VERSION_MARKS_DENIED' } }), mine, [draft])).rejects.toBeInstanceOf(VersionMarksDenied);
  });

  it('any other database failure reads as unavailable, and a review row of a newer date wins', async () => {
    await expect(loadVersionMarks(rpc({ error: { message: 'permission denied for table opc_drafts' } }), mine, [draft])).rejects.toThrow('FUSION_REVIEW_UNAVAILABLE');
    const newer = { versions: [v('a')], reviews: [done('old', 'a', { created_at: '2026-10-01T00:00:00Z' } as never), done('new', 'a', { created_at: '2026-10-02T00:00:00Z' } as never)] };
    expect((await loadVersionMarks(rpc({ data: newer }), mine, [draft])).a).toMatchObject({ reviewId: 'new' });
    expect(await loadVersionMarks(rpc({ data: null }), mine, [draft])).toEqual({});
  });
});
