/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { estimateFusion, startCompare, startJury } from './turn-fusion';

const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const asFetch = (handler: (path: string, body: Record<string, unknown>) => Response): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), JSON.parse(String(init?.body)))) as typeof fetch;

it('prices a compare or a jury on the estimate route and throws a refusal as its fixed code', async () => {
  const seen: Array<[string, unknown]> = [];
  const ok = asFetch((path, body) => { seen.push([path, body]); return json(200, { credits: 12, columns: [] }); });
  expect(await estimateFusion({ kind: 'compare' }, { fetch: ok })).toEqual({ credits: 12, columns: [] });
  expect(seen[0]).toEqual(['/api/turn/estimate', { kind: 'compare' }]);
  await expect(estimateFusion({}, { fetch: asFetch(() => json(403, { error: 'FUSION_COMPARE_FORBIDDEN' })) })).rejects.toThrow('FUSION_COMPARE_FORBIDDEN');
});

it('a compare resolves as soon as it is opened, feeds each column with its compare id, and finishes with the stream', async () => {
  const calls: string[] = [];
  const run = startCompare({ sessionId: 's', requestId: 'r', question: 'q', modelIds: ['a'], shown: {} }, {
    onOpened: id => calls.push('open:' + id), onColumn: (id, index, delta) => calls.push(`col:${id}:${index}:${delta}`),
    onAnswer: (id, index, ok) => calls.push(`answer:${id}:${index}:${ok}`) },
  { fetch: asFetch(path => { calls.push(path); return sse({ type: 'opened', turnId: 3, compareId: 'c1', reservedCredits: 5, replay: false },
    { type: 'column', index: 0, delta: 'Hi' }, { type: 'answer', index: 0, ok: true }, { type: 'result', turnId: 3, compareId: 'c1', chargedCredits: 1, settlement: 'done' }); }) });
  expect(await run.started).toEqual({ compareId: 'c1', turnId: 3 });
  await run.finished;
  expect(calls).toEqual(['/api/turn/compare', 'open:c1', 'col:c1:0:Hi', 'answer:c1:0:true']);
});

it('a compare refused before it opened throws the code; a lost answer throws TURN_LOST so the same request id is kept', async () => {
  const body = { sessionId: 's', requestId: 'r', question: 'q', modelIds: ['a'], shown: {} };
  const live = { onOpened: () => {}, onColumn: () => {}, onAnswer: () => {} };
  const refused = startCompare(body, live, { fetch: asFetch(() => json(403, { error: 'FUSION_COMPARE_FORBIDDEN' })) });
  await expect(refused.started).rejects.toThrow('FUSION_COMPARE_FORBIDDEN');
  const errored = startCompare(body, live, { fetch: asFetch(() => sse({ type: 'error', code: 'FUSION_COMPARE_PRICE_CHANGED' })) });
  await expect(errored.started).rejects.toThrow('FUSION_COMPARE_PRICE_CHANGED');
  const lost = startCompare(body, live, { fetch: asFetch(() => sse()) });
  await expect(lost.started).rejects.toThrow('TURN_LOST');
});

it('a jury start returns the review id from the review event, sending kind=jury', async () => {
  const sent: unknown[] = [];
  const fetch = asFetch((path, body) => { sent.push([path, body]);
    return sse({ type: 'review', turnId: 9, reviewId: 'rv', state: 'running', reservedCredits: 100 }); });
  expect(await startJury({ requestId: 'r', draftId: 'd', sourceVersionId: 'v', acceptedCredits: 50 }, { fetch })).toEqual({ reviewId: 'rv' });
  expect(sent[0]).toEqual(['/api/turn', { kind: 'jury', requestId: 'r', draftId: 'd', sourceVersionId: 'v', acceptedCredits: 50 }]);
  await expect(startJury({ requestId: 'r', draftId: 'd', sourceVersionId: 'v' }, { fetch: asFetch(() => sse({ type: 'error', code: 'FUSION_REVIEW_ACTIVE' })) }))
    .rejects.toThrow('FUSION_REVIEW_ACTIVE');
});
