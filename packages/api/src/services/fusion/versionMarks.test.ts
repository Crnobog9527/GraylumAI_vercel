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
  const rows = (data: unknown) => ({ select: () => chain(data), in: () => chain(data), is: () => chain(data), eq: () => chain(data),
    order: () => chain(data), limit: () => Promise.resolve({ data, error: null }) });
  const chain = (data: unknown): never => ({ ...rows(data), then: (resolve: (value: unknown) => void) => resolve({ data, error: null }) }) as never;
  const admin = (drafts: unknown) => ({ from: (table: string) => table === 'opc_drafts' ? chain(drafts)
    : table === 'artifact_versions' ? chain([{ id: 'a', source: null, from: null }]) : chain([done('r', 'a')]) }) as never;
  const mine = 'u1', draft = '10000000-0000-4000-8000-000000000001';

  it('answers for the caller\'s own analyses', async () => {
    const marks = await loadVersionMarks(admin([{ draft_id: draft, project_id: 'p', actor_id: mine }]), mine, [draft]);
    expect(marks.a).toMatchObject({ mark: 'reviewed' });
  });

  it('refuses another user\'s analysis, and an unknown one, instead of answering empty', async () => {
    await expect(loadVersionMarks(admin([{ draft_id: draft, project_id: 'p', actor_id: 'someone-else' }]), mine, [draft]))
      .rejects.toBeInstanceOf(VersionMarksDenied);
    await expect(loadVersionMarks(admin([]), mine, [draft])).rejects.toBeInstanceOf(VersionMarksDenied);
    await expect(loadVersionMarks(admin([{ draft_id: draft, project_id: 'p', actor_id: mine }]), mine,
      [draft, '10000000-0000-4000-8000-000000000002'])).rejects.toBeInstanceOf(VersionMarksDenied);
  });
});
