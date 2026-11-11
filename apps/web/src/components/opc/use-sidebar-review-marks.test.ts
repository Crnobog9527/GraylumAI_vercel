/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarReviewMarks } from './use-sidebar-review-marks';

const mine = vi.hoisted(() => vi.fn());
vi.mock('@/trpc/client', () => ({ trpc: { fusionReview: { mine: { useQuery: mine } } } }));

const review = (draftId: string, reviewId: string, state: string, createdAt: string) =>
  ({ draftId, reviewId, state, outcome: null, seen: false, createdAt, account: null, versionNumber: 1 });

beforeEach(() => { mine.mockReset(); });

describe('useSidebarReviewMarks', () => {
  it('asks at once, with the sidebar lists, instead of waiting for them (no `enabled` switch)', () => {
    mine.mockReturnValue({ data: undefined });
    useSidebarReviewMarks();
    expect(mine).toHaveBeenCalledOnce();
    const [input, options] = mine.mock.calls[0];
    expect(input).toEqual({ limit: 50 });
    expect(options).not.toHaveProperty('enabled');
    expect(options).toMatchObject({ staleTime: 30_000 });
    expect(typeof options.retry).toBe('function');
  });

  it.each([[undefined], [null], [[]]])('shows no mark while the read is out, when it failed, or without a review (data %j)', data => {
    mine.mockReturnValue({ data });
    const marks = useSidebarReviewMarks();
    expect(marks.label('d1')).toBeUndefined();
    expect(marks.note('d1')).toBe('');
  });

  it('gives the mark of a draft whose newest review is running, alone and as the tail of an account row', () => {
    mine.mockReturnValue({ data: [review('d1', 'r1', 'running', '2026-11-11T00:00:00Z')] });
    const marks = useSidebarReviewMarks();
    const label = marks.label('d1');
    expect(label).toBeTruthy();
    expect(marks.note('d1')).toBe(' · ' + label);
    expect(marks.note('other')).toBe('');
  });
});
