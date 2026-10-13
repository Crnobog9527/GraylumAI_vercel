/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createRenameRevisions } from './conversation-rename';

describe('createRenameRevisions', () => {
  it('lets only the latest edit of a conversation roll back', () => {
    const revisions = createRenameRevisions();
    const first = revisions.begin('a', '原名');
    const second = revisions.begin('a', '第一次');
    expect(revisions.isLatest('a', first)).toBe(false);
    expect(revisions.isLatest('a', second)).toBe(true);
  });

  it('rolls back to the last confirmed title, never to an optimistic one', () => {
    const revisions = createRenameRevisions();
    revisions.begin('a', '原名');
    revisions.begin('a', '第一次'); // shown optimistically, never saved
    revisions.settle('a', null); // first failed
    revisions.settle('a', null); // second failed
    expect(revisions.rollbackTitle('a', '第一次')).toBe('原名');
  });

  it('moves the confirmed title forward after a successful save', () => {
    const revisions = createRenameRevisions();
    revisions.begin('a', '原名');
    revisions.settle('a', '新名');
    revisions.begin('a', '新名');
    revisions.settle('a', null);
    expect(revisions.rollbackTitle('a', '别的')).toBe('新名');
  });

  it('tracks conversations independently', () => {
    const revisions = createRenameRevisions();
    const a = revisions.begin('a', 'A');
    revisions.begin('b', 'B');
    expect(revisions.isLatest('a', a)).toBe(true);
    expect(revisions.rollbackTitle('b', 'x')).toBe('B');
  });
});
