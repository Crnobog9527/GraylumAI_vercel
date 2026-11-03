/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTRPCUntypedClient, httpBatchLink } from '@trpc/client';
import { isTransientReadError, MAX_RETRY_DELAY_MS, READ_RETRIES, readRetry, readRetryDelay } from './read-retry';

/*
 * The errors are made by the real tRPC client against a server that answers the way the app does: the web proxy (apps/web/src/proxy.ts)
 * answers with plain JSON, not a tRPC error (a 429 when rate limited, a 503 with Retry-After 60 when its rate-limit backend is slow),
 * and a procedure's own failure is a tRPC error. The client keeps the proxy's status on `meta.response`, with no `data`.
 */
let server: Server;
let url = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const plain = (status: number, headers: Record<string, string>) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ error: 'x', message: 'm', retryAfter: Number(headers['retry-after'] ?? 0) }));
    };
    const name = decodeURIComponent(req.url ?? '');
    if (name.includes('proxy429')) return plain(429, { 'retry-after': '30' });
    if (name.includes('proxy503-long')) return plain(503, { 'retry-after': '60' });
    if (name.includes('proxy503-short')) return plain(503, { 'retry-after': '2' });
    if (name.includes('proxy503')) return plain(503, {});
    if (name.includes('proxy401')) return plain(401, {});
    const code = name.includes('forbidden') ? ['FORBIDDEN', 403] : name.includes('unavailable') ? ['SERVICE_UNAVAILABLE', 503] : ['INTERNAL_SERVER_ERROR', 500];
    res.writeHead(code[1] as number, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ error: { message: 'boom', code: -32603, data: { code: code[0], httpStatus: code[1] } } }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/trpc`;
});
afterAll(() => new Promise<void>(resolve => { server.close(() => resolve()); }));

const failure = async (procedure: string, base = () => url): Promise<unknown> => {
  const client = createTRPCUntypedClient({ links: [httpBatchLink({ url: base() })] });
  try { await client.query(procedure); } catch (error) { return error; }
  throw new Error('the call did not fail');
};

describe('read retry policy, with the errors the real client makes', () => {
  it("asks again after a procedure's own server failure", async () => {
    expect(isTransientReadError(await failure('boom'))).toBe(true);
    expect(isTransientReadError(await failure('unavailable'))).toBe(true);
  });

  it('asks again after the proxy answers 503 without asking for a long wait, or asks for a short one', async () => {
    expect(isTransientReadError(await failure('proxy503'))).toBe(true);
    expect(isTransientReadError(await failure('proxy503-short'))).toBe(true);
  });

  it('does not ask again sooner than the proxy asked: its 503 with Retry-After 60 shows the notice, the retry button asks later', async () => {
    expect(isTransientReadError(await failure('proxy503-long'))).toBe(false);
  });

  it('never asks again after the proxy rate limits (429), however it is shaped, or after a refusal or a missing login', async () => {
    expect(isTransientReadError(await failure('proxy429'))).toBe(false);
    expect(isTransientReadError(await failure('forbidden'))).toBe(false);
    expect(isTransientReadError(await failure('proxy401'))).toBe(false);
    expect(isTransientReadError({ data: { httpStatus: 404, code: 'NOT_FOUND' } })).toBe(false);
    expect(isTransientReadError({ data: { httpStatus: 401, code: 'UNAUTHORIZED' } })).toBe(false);
  });

  it('asks again when there was no response at all', async () => {
    expect(isTransientReadError(await failure('anything', () => 'http://127.0.0.1:1/api/trpc'))).toBe(true);
    expect(isTransientReadError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('asks at most twice, and waits a second, then two, never more than four', async () => {
    expect(READ_RETRIES).toBe(2);
    expect([0, 1, 2, 3].map(count => readRetry(count, { data: { httpStatus: 503 } }))).toEqual([true, true, false, false]);
    expect(readRetry(0, await failure('proxy429'))).toBe(false);
    expect(MAX_RETRY_DELAY_MS).toBe(4000);
    expect([0, 1, 2, 3, 9].map(readRetryDelay)).toEqual([1000, 2000, 4000, 4000, 4000]);
  });
});
