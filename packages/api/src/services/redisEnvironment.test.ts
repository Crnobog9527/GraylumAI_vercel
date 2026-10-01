/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { redisEnvironment } from './redisEnvironment';
const canonical = { UPSTASH_REDIS_REST_URL: 'https://canonical.invalid', UPSTASH_REDIS_REST_TOKEN: 'synthetic-a' };
const integrated = { KV_REST_API_URL: 'https://integrated.invalid', KV_REST_API_TOKEN: 'synthetic-b' };
it('selects complete canonical pair before integrated pair', () => {
  expect(redisEnvironment({ ...canonical, ...integrated })).toEqual({ url: canonical.UPSTASH_REDIS_REST_URL,
    token: canonical.UPSTASH_REDIS_REST_TOKEN });
});
it('supports the complete Vercel integration namespace', () => {
  expect(redisEnvironment(integrated)).toEqual({ url: integrated.KV_REST_API_URL, token: integrated.KV_REST_API_TOKEN });
});
it.each([
  {}, { KV_REST_API_URL: integrated.KV_REST_API_URL },
  { ...integrated, UPSTASH_REDIS_REST_URL: canonical.UPSTASH_REDIS_REST_URL },
  { ...integrated, UPSTASH_REDIS_REST_TOKEN: canonical.UPSTASH_REDIS_REST_TOKEN },
  { UPSTASH_REDIS_REST_URL: canonical.UPSTASH_REDIS_REST_URL, KV_REST_API_TOKEN: integrated.KV_REST_API_TOKEN },
])('never combines partial namespaces or uses read-only tokens %#', env => {
  expect(() => redisEnvironment({ ...env, KV_REST_API_READ_ONLY_TOKEN: 'synthetic-read-only' }))
    .toThrow('REDIS_ENV_INCOMPLETE');
});
