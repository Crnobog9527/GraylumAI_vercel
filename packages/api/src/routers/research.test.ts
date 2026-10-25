/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { researchRouter } from './research';

it('requires authentication for every user-facing research endpoint', async () => {
  const caller = researchRouter.createCaller({ user: null } as never);
  const id = '00000000-0000-4000-8000-000000000001';
  const calls = [
    caller.cards({ sessionId: id }),
    caller.benchmarks({ sessionId: id }),
    caller.unfinishedRound({ sessionId: id }),
    caller.confirmCard({ cardId: id, selected: [] }),
    caller.createRefresh({ sessionId: id, platform: 'x', account: 'alice' }),
    caller.toolCharges({ transactionId: id }),
    caller.evidence({ limit: 20 }),
  ];
  const results = await Promise.allSettled(calls);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.code).toBe('UNAUTHORIZED');
  }
});
