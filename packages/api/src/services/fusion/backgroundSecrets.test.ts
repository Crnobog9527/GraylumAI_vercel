/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import { getPlatformSecret } from '../platformSecrets/reader';

const turn = vi.hoisted(() => ({ advance: async () => ({ next: false, reason: 'idle' }) as unknown }));
vi.mock('./reviewRecord', async importOriginal => ({ ...await importOriginal<typeof import('./reviewRecord')>(),
  reviewRecord: () => ({ read: async () => ({ turnId: 7, state: 'running' }) }) }));
vi.mock('../turn/jury', () => ({ juryTurn: () => ({ advance: () => turn.advance() }) }));
vi.mock('../turn/db', () => ({ turnClients: () => ({}) }));
import { advanceReview } from './background';

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
  const jury = { slots: {} as never, calls: (async () => ({ allowed: true })) as never };
  turn.advance = async () => {
    // The seats of one group run in parallel inside one advance.
    await Promise.all([read(), read()].map(async call => expect((await call).value).toBe(expected)));
    key = 'synthetic-replaced-during-advance';
    return { next: true, reason: 'advanced', dispatched: 2 };
  };
  expect(await advanceReview({ admin: db, reviewId: '10000000-0000-4000-8000-000000000002', jury }))
    .toEqual({ next: true, reason: 'advanced', dispatched: 2 });
  expect(secretRead).toHaveBeenCalledTimes(1);
  expected = key;
  expect(await advanceReview({ admin: db, reviewId: '10000000-0000-4000-8000-000000000002', jury }))
    .toEqual({ next: true, reason: 'advanced', dispatched: 2 });
  expect(secretRead).toHaveBeenCalledTimes(2);
});
