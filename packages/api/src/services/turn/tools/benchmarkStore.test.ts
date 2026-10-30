/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { preparedResearch, turnResearchStore } from './benchmarkStore';

const actorId = '11111111-1111-4111-8111-111111111111', sessionId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333', opId = '44444444-4444-4444-8444-444444444444';
const fetchId = '55555555-5555-4555-8555-555555555555', attempt = '66666666-6666-4666-8666-666666666666';
const make = (over: Record<string, unknown> = {}) => turnResearchStore({ actorId, sessionId, requestId, text: 'hi', prepared: preparedResearch.parse(over) });

it('reuses a crashed turn\'s paid operation and writes it at the next close', async () => {
  const op = { id: opId, identityHash: 'a'.repeat(64), state: 'succeeded', result: { items: [] }, quoteUnits: 10, discoveryId: null };
  const s = make({ unapplied: [[op]] });
  expect(await s.store.readOperation(opId)).toMatchObject({ state: 'succeeded' });
  expect(s.journal()?.operations.map(o => o.id)).toEqual([opId]);
});

it('never pays again for a fetched account, and a free failure may be claimed again with a new attempt', async () => {
  const evidence = { platform: 'tiktok' };
  const done = make({ fetches: [{ id: fetchId, attempt, platform: 'tiktok', account: 'a', state: 'succeeded', evidence }] });
  expect(await done.store.fetchClaim('tiktok', 'a')).toEqual({ claimed: false, fetchId, state: 'succeeded', evidence });
  const failed = make({ fetches: [{ id: fetchId, attempt, platform: 'tiktok', account: 'a', state: 'failed', evidence: null }] });
  const claim = await failed.store.fetchClaim('tiktok', 'a');
  expect(claim).toMatchObject({ claimed: true, fetchId });
  expect((claim as { attempt: string }).attempt).not.toBe(attempt);
  const unknown = make({ fetches: [{ id: fetchId, attempt, platform: 'tiktok', account: 'a', state: 'unknown', evidence: null }] });
  expect(await unknown.store.fetchClaim('tiktok', 'a')).toMatchObject({ claimed: false });
});

it('a turn that made nothing has no journal; a card is kept for close', async () => {
  const s = make();
  expect(s.journal()).toBeUndefined();
  await s.store.createCard(opId, { kind: 'keywords', options: [{ id: 'k0', text: 'a' }] });
  expect(s.journal()?.cards).toHaveLength(1);
});

it('offers the shortfall card only when it is due', async () => {
  const due = make({ shortfall: { rounds: 2, qualified: 1, card: null } });
  expect(await due.store.offerShortfall(opId)).toMatchObject({ offeredRounds: 2, offeredQualified: 1 });
  expect(await make({ shortfall: { rounds: 1, qualified: 1, card: null } }).store.offerShortfall(opId)).toBeNull();
  expect(await make({ shortfall: { rounds: 3, qualified: 3, card: null } }).store.offerShortfall(opId)).toBeNull();
});

it('only this turn\'s own message authorizes a pasted link', async () => {
  const s = make(), scope = { userId: actorId, sessionId };
  expect(await s.store.authorization.userMessage(scope, requestId)).toBe('hi');
  expect(await s.store.authorization.userMessage(scope, opId)).toBeNull();
  expect(await s.store.authorization.userMessage({ userId: opId, sessionId }, requestId)).toBeNull();
});
