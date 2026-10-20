/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/trpc/client', () => ({ trpc: { fusionReview: { versionMarks: { useQuery: () => ({ data: undefined }) } } } }));
import { MARK_TEXT, VersionMark, type VersionMarkData } from './VersionMark';

const reviewed: VersionMarkData = { mark: 'reviewed', reviewId: 'r', draftId: 'd', reviewedAt: '2026-10-19T10:00:00Z', adoptedCount: 0, derivedFrom: null };
const derived: VersionMarkData = { mark: 'derived', reviewId: null, draftId: null, reviewedAt: null, adoptedCount: 0, derivedFrom: 'v' };

it('shows nothing on an ordinary report', () => {
  expect(renderToStaticMarkup(<VersionMark mark={null} />)).toBe('');
  expect(renderToStaticMarkup(<VersionMark mark={undefined} />)).toBe('');
});

it('shows 已评审 as a button that keeps its details closed until clicked, and 衍生 as plain outlined text', () => {
  const html = renderToStaticMarkup(<VersionMark mark={reviewed} />);
  expect(html).toContain(MARK_TEXT.reviewed);
  expect(html).toContain('<button');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('评审日期');
  const outline = renderToStaticMarkup(<VersionMark mark={derived} />);
  expect(outline).toContain(MARK_TEXT.derived);
  expect(outline).not.toContain('<button');
  expect(outline).not.toContain(MARK_TEXT.reviewed);
});

it('inside a card that is itself a button the 已评审 mark is plain text (no button in a button)', () => {
  const html = renderToStaticMarkup(<VersionMark mark={reviewed} inert />);
  expect(html).toContain(MARK_TEXT.reviewed);
  expect(html).not.toContain('<button');
});
