/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createRenameRevisions } from './conversation-rename';

describe('createRenameRevisions', () => {
  it('lets only the latest edit of a conversation roll back', () => {
    const revisions = createRenameRevisions();
    const first = revisions.next('a');
    const second = revisions.next('a');
    expect(revisions.isLatest('a', first)).toBe(false);
    expect(revisions.isLatest('a', second)).toBe(true);
  });
  it('tracks conversations independently', () => {
    const revisions = createRenameRevisions();
    const a = revisions.next('a');
    revisions.next('b');
    expect(revisions.isLatest('a', a)).toBe(true);
  });
});
