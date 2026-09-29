import { expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { router, publicProcedure } from '../trpc';
import { RateLimitError } from './rateLimitError';

it.each(['unavailable', 'rate_limited'] as const)('serializes %s retryAfter over the real tRPC adapter', async reason => {
  const testRouter = router({ probe: publicProcedure.mutation(() => { throw new RateLimitError(reason, 60); }) });
  const response = await fetchRequestHandler({
    endpoint: '/trpc', router: testRouter, createContext: () => ({} as never),
    req: new Request('http://localhost/trpc/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  });
  expect(response.status).toBe(reason === 'unavailable' ? 503 : 429);
  const body = await response.json();
  expect(body.error.data.retryAfter).toBe(60);
  expect(body.error.message).toBe(reason === 'unavailable' ? '服务暂时繁忙，请稍后再试' : '请求过于频繁，请在 60 秒后重试');
});

it('does not serialize arbitrary internal cause data', async () => {
  const testRouter = router({ probe: publicProcedure.mutation(() => {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Safe message', cause: { retryAfter: 99, secret: 'private' } });
  }) });
  const response = await fetchRequestHandler({ endpoint: '/trpc', router: testRouter, createContext: () => ({} as never),
    req: new Request('http://localhost/trpc/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  });
  const body = await response.json();
  expect(body.error.data.retryAfter).toBeUndefined();
  expect(body.error.data.secret).toBeUndefined();
});
