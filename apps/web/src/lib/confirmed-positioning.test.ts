/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { confirmedDraftId, draftConfirmed, isNewUser } from './confirmed-positioning';

const read = (drafts: unknown) => ({ isPending: false, error: null, data: { drafts } });

describe('whether the user has a confirmed positioning', () => {
  it('counts a published draft, and a revision of one that was published before', () => {
    expect(draftConfirmed({ state: 'published' })).toBe(true);
    expect(draftConfirmed({ state: 'draft', currentVersion: 2 })).toBe(true);
    expect(draftConfirmed({ state: 'draft', currentVersion: 0 })).toBe(false);
    expect(draftConfirmed({ state: 'draft' })).toBe(false);
  });

  it('names the first confirmed draft, and none when the list has none', () => {
    expect(confirmedDraftId(read([{ draftId: 'a', state: 'draft' }, { draftId: 'b', state: 'published' }, { draftId: 'c', state: 'published' }]))).toBe('b');
    expect(confirmedDraftId(read([{ draftId: 'a', state: 'draft' }]))).toBeNull();
    expect(isNewUser(read([{ draftId: 'a', state: 'draft' }]))).toBe(true);
    expect(isNewUser(read([]))).toBe(true);
    expect(isNewUser(read([{ draftId: 'b', state: 'draft', currentVersion: 1 }]))).toBe(false);
  });

  it('knows nothing while the list is read, cannot be read or is not a list: neither a new user nor a confirmed draft', () => {
    for (const unknown of [{ isPending: true, error: null }, { isPending: false, error: { message: 'x' } }, { isPending: false, error: null },
      { isPending: false, error: null, data: { drafts: 'x' } }]) {
      expect(isNewUser(unknown)).toBe(false);
      expect(confirmedDraftId(unknown)).toBeNull();
    }
  });
});
