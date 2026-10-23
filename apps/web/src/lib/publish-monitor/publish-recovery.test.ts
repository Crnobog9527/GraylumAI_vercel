/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { clearAttempt, loadAttempt, saveAttempt, sameFiles, type StoredAttempt } from './publish-recovery';

const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data }; };
const attempt: StoredAttempt = { key: 'pub-00000001', connectionIds: ['c1'], caption: 'Hi', maxHoldCredits: 6,
  media: [{ sha256: 'a'.repeat(64), size: 5, mimeType: 'video/mp4', coverMs: 1500 }] };

describe('publish recovery', () => {
  it('keeps the key and file identities across a reload, and never a media link', () => {
    const store = memory();
    saveAttempt('item', attempt, store);
    expect(loadAttempt('item', store)).toEqual(attempt);
    expect(loadAttempt('other', store)).toBeNull();
    expect([...store.data.values()].join()).not.toMatch(/https?:/);
    clearAttempt('item', store);
    expect(loadAttempt('item', store)).toBeNull();
  });

  it('ignores damaged or missing storage', () => {
    const store = memory();
    store.setItem('publish-monitor-attempt:item', '{"key":1}');
    expect(loadAttempt('item', store)).toBeNull();
    store.setItem('publish-monitor-attempt:item', 'not json');
    expect(loadAttempt('item', store)).toBeNull();
    expect(loadAttempt('item', null)).toBeNull();
    expect(() => saveAttempt('item', attempt, null)).not.toThrow();
  });

  it('accepts only the same files in the same order', () => {
    expect(sameFiles(attempt, ['a'.repeat(64)])).toBe(true);
    expect(sameFiles(attempt, ['b'.repeat(64)])).toBe(false);
    expect(sameFiles(attempt, [])).toBe(false);
    expect(sameFiles({ ...attempt, media: [] }, [])).toBe(true);
  });
});
