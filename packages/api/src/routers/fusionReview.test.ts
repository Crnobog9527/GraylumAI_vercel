/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { revisionHooks } from './fusionReview';

describe('fusion review router', () => {
  it('gives the review flow every R14 call it needs, including decline', async () => {
    const revisions = {
      propose: vi.fn(async () => ({ revisionId: 'r', diffHash: 'h', diff: { changes: [], cascade: [] } }) as never),
      apply: vi.fn(async () => ({ versionId: 'v' }) as never),
      decline: vi.fn(async () => null as never),
    };
    const hooks = revisionHooks(revisions);
    expect(await hooks.propose({})).toEqual({ revisionId: 'r', diffHash: 'h', diff: { changes: [], cascade: [] } });
    expect(await hooks.apply({})).toEqual({ versionId: 'v' });
    await hooks.decline({});
    expect(revisions.decline).toHaveBeenCalledOnce();
  });
});
