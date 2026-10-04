/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { openRouterNotFound } from './openRouterNotFound';
import type { TransportObservation } from './fixtureAdapter';
const identity = { provider: 'openrouter', account: 'synthetic', model: 'synthetic/model',
  protocol: 'openrouter-chat-v1' as const };
function observation(body: unknown = { error: { code: 404, message: 'SYNTHETIC_PRIVATE' } }): TransportObservation {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return { rawBody, rawBodyBase64: Buffer.from(rawBody).toString('base64'),
    sourceHash: createHash('sha256').update(rawBody).digest('hex'),
    httpStatus: 404, complete: true, transportIssue: null };
}
it('retains only the financial identity and body hash for a complete missing record', () => {
  const result = openRouterNotFound(observation({ user_id: 'SYNTHETIC_PRIVATE',
    error: { code: 404, message: 'SYNTHETIC_PRIVATE' } }), identity);
  expect(result).toMatchObject({ cost: null, final: false, evidenceKind: 'provider_rejection_lookup' });
  expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_PRIVATE|rawBody|user_id/);
});
it.each([{ httpStatus: 500 }, { httpStatus: 200 }, { complete: false }, { transportIssue: 'body_timeout' },
  { generationId: 'gen-unexpected' }, { sourceHash: 'f'.repeat(64) }])('does not count ambiguous transport %j', patch => {
  expect(openRouterNotFound({ ...observation(), ...patch }, identity)).toBeNull();
});
it.each([{ data: { total_cost: 0 } }, { data: { finish_reason: 'stop' } }, { usage: {} }, { cost: 0 },
  { output: [] }, { error: { code: 500, message: 'synthetic' } },
  '{"error":{"code":404,"code":404,"message":"synthetic"}}'])('does not count records or unrecognized bodies %j', body => {
  expect(openRouterNotFound(observation(body), identity)).toBeNull();
});

it.each([undefined, null])('accepts a matched official record with no total cost (%s)', total_cost => {
 const obs={...observation({data:{id:'gen-synthetic',model:identity.model,finish_reason:'stop',total_cost}}),httpStatus:200};
 expect(openRouterNotFound(obs,identity,'gen-synthetic')).toMatchObject({lookupOutcome:'no_cost',providerId:'gen-synthetic'});
});
it.each([{total_cost:0},{total_cost:0.003},{total_cost:'invalid'},{usage:{}},{output:'text'},
 {native_tokens_completion:1},{id:'gen-other'},{model:'other/model'},{unrecognized:1}])('does not forgive other evidence %j', patch => {
 const obs={...observation({data:{id:'gen-synthetic',model:identity.model,...patch}}),httpStatus:200};
 expect(openRouterNotFound(obs,identity,'gen-synthetic')).toBeNull();
});
