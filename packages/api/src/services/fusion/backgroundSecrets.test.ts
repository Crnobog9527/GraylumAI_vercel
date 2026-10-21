/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import { advanceReview } from './background';
import { getPlatformSecret } from '../platformSecrets/reader';

it('each real advance entry shares one fresh read across its parallel calls and the next advance sees a new key', async () => {
  let key = 'synthetic-advance-old';
  let expected = key;
  const secretRead = vi.fn(async () => ({ data: key, error: null }));
  const db = { rpc: (name: string) => {
    if (name === 'platform_secret_read') return { abortSignal: secretRead };
    return Promise.resolve({ data: name === 'fusion_review_advance_lease'
      ? { acquired: true, reason: 'acquired', actorId: '10000000-0000-4000-8000-000000000001' } : true, error: null });
  } } as never;
  const read = () => getPlatformSecret(db, 'openrouter', { fresh: true });
  const flow = () => ({
    continue: async () => {
      expect((await read()).value).toBe(expected);
      key = 'synthetic-replaced-during-advance';
      return { review: { state: 'running' }, calls: [{ callId: 'a', dispatched: false }, { callId: 'b', dispatched: false }] };
    },
    dispatch: async () => {
      expect((await read()).value).toBe(expected);
      return { state: 'judged', verdict: 'usable' };
    },
  }) as never;
  expect(await advanceReview({ admin: db, reviewId: '10000000-0000-4000-8000-000000000002', flow }))
    .toEqual({ next: true, reason: 'advanced', dispatched: 2 });
  expect(secretRead).toHaveBeenCalledTimes(1);
  expected = key;
  expect(await advanceReview({ admin: db, reviewId: '10000000-0000-4000-8000-000000000002', flow }))
    .toEqual({ next: true, reason: 'advanced', dispatched: 2 });
  expect(secretRead).toHaveBeenCalledTimes(2);
});
