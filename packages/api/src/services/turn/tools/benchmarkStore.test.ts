/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { stableResearchId } from '../../research/runtime/toolContext';
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

it('a claim the budget stopped before sending is not written at close', async () => {
  const s = make();
  const claim = await s.store.fetchClaim('tiktok', 'a');
  expect(claim).toMatchObject({ claimed: true });
  expect(s.journal()).toBeUndefined();
  const { fetchId: id, attempt: a } = claim as { fetchId: string; attempt: string };
  await s.store.fetchFinish(id, a, 'failed', null);
  expect(s.journal()?.fetches).toHaveLength(1);
});

it('a finished round stays readable for a follow-up card', async () => {
  const s = make({ discoveries: [{ discoveryId: opId, keywords: ['a'], platforms: ['tiktok'], cursor: { accounts: [] }, state: 'completed',
    keywordConfirmationId: fetchId }] });
  expect(await s.store.discoveryRead(opId)).toMatchObject({ state: 'completed' });
  expect(s.finishedRound({ discoveryId: opId })).toBe(true);
  expect(s.finishedRound({ keywordConfirmationId: fetchId })).toBe(true);
  expect(s.finishedRound({ discoveryId: fetchId, keywordConfirmationId: opId })).toBe(false);
});

it('a fetch paid before a crash resumes with the same ids instead of paying again', async () => {
  const first = await make().store.fetchClaim('tiktok', 'a') as { fetchId: string; attempt: string };
  const again = await make().store.fetchClaim('tiktok', 'a') as { fetchId: string; attempt: string; resumed?: true };
  expect([again.fetchId, again.attempt]).toEqual([first.fetchId, first.attempt]);
  expect(again.resumed).toBeUndefined();
  const paid = { id: stableResearchId(first.fetchId, first.attempt, 'account_profile'), identityHash: 'a'.repeat(64), state: 'succeeded', result: { items: [] } };
  const resumed = await make({ unapplied: [[paid]] }).store.fetchClaim('tiktok', 'a');
  expect(resumed).toMatchObject({ claimed: true, fetchId: first.fetchId, attempt: first.attempt, resumed: true });
});

it('a pasted link counts only for the account it named', async () => {
  const s = make();
  const claim = await s.store.fetchClaim('tiktok', 'a') as { fetchId: string; attempt: string };
  const other = await s.store.fetchClaim('tiktok', 'b') as { fetchId: string; attempt: string };
  const port = s.store.evidence();
  await port.open(opId, 'a'.repeat(64), 1);
  await port.finish(opId, opId, 'succeeded', { args: { source: { kind: 'user_message' } }, call: { platform: 'tiktok', query: 'A' } });
  await s.store.fetchFinish(claim.fetchId, claim.attempt, 'failed', null);
  await s.store.fetchFinish(other.fetchId, other.attempt, 'failed', null);
  expect(s.journal()?.fetches.map(f => [f.account, f.pasted]).sort()).toEqual([['a', true], ['b', false]]);
});

it('a pasted check that succeeded this turn counts toward the shortfall card, once', async () => {
  const s = make({ shortfall: { rounds: 1, qualified: 0, card: null } });
  expect(await s.store.offerShortfall(opId)).toBeNull();
  const claim = await s.store.fetchClaim('tiktok', 'a') as { fetchId: string; attempt: string };
  const port = s.store.evidence();
  await port.open(opId, 'a'.repeat(64), 1);
  await port.finish(opId, opId, 'succeeded', { args: { source: { kind: 'user_message' } }, call: { platform: 'tiktok', query: 'a' } });
  await s.store.fetchFinish(claim.fetchId, claim.attempt, 'succeeded', { classification: { qualified: true } });
  expect(await s.store.offerShortfall(opId)).toMatchObject({ offeredRounds: 2, offeredQualified: 1 });
});

it('a refresh grant replaces a finished fetch, and is written at close', async () => {
  const refreshId = '77777777-7777-4777-8777-777777777777';
  const s = turnResearchStore({ actorId, sessionId, requestId, text: 'hi', refreshId, prepared: preparedResearch.parse({
    refresh: { platform: 'tiktok', account: 'homeideas', used: false },
    fetches: [{ id: fetchId, attempt, platform: 'tiktok', account: 'homeideas', state: 'succeeded', evidence: { platform: 'tiktok' } }] }) });
  expect(await s.store.authorization.refreshGrant({ userId: actorId, sessionId }, refreshId)).toMatchObject({ account: 'homeideas', used: false });
  expect(await s.store.authorization.refreshGrant({ userId: actorId, sessionId }, opId)).toBeNull();
  const claim = await s.store.fetchClaim('tiktok', 'homeideas', refreshId) as { fetchId: string; attempt: string };
  await s.store.fetchFinish(claim.fetchId, claim.attempt, 'failed', null);
  expect(s.journal()?.fetches[0]).toMatchObject({ refreshId });
});

it('accounts that differ only by case stay apart on a case-sensitive platform', async () => {
  const youtube = make({ fetches: [{ id: fetchId, attempt, platform: 'youtube', account: 'UCabc', state: 'succeeded', evidence: { platform: 'youtube' } }] });
  expect(await youtube.store.fetchClaim('youtube', 'UCABC')).toMatchObject({ claimed: true });
  expect(await youtube.store.fetchClaim('youtube', 'UCabc')).toMatchObject({ claimed: false });
  const tiktok = make({ fetches: [{ id: fetchId, attempt, platform: 'tiktok', account: 'abc', state: 'succeeded', evidence: { platform: 'tiktok' } }] });
  expect(await tiktok.store.fetchClaim('tiktok', 'ABC')).toMatchObject({ claimed: false });
});
