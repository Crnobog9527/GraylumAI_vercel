/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createTRPCUntypedClient } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';
import { transportLink } from './transport-link';

/** A tRPC server stand-in: answers every call of a request with its own procedure path, and records what was asked. */
function fakeServer() {
  const requests: Array<{ paths: string[]; batched: boolean; authorization: string | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const paths = decodeURIComponent(url.pathname.replace('/api/trpc/', '')).split(',');
    const batched = url.searchParams.get('batch') === '1';
    requests.push({ paths, batched, authorization: new Headers(init?.headers).get('authorization') });
    const results = paths.map(path => ({ result: { data: path } }));
    return new Response(JSON.stringify(batched ? results : results[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { fetch, requests };
}

function client(server: ReturnType<typeof fakeServer>) {
  return createTRPCUntypedClient({
    links: [transportLink({ url: 'http://localhost/api/trpc', maxItems: 10, fetch: server.fetch as typeof fetch, headers: () => ({ Authorization: 'Bearer test' }) })],
  });
}

describe('transportLink', () => {
  it('sends calls made at the same moment as three requests: the shared batch, the slow reads, and each unbatched read', async () => {
    const server = fakeServer();
    const trpc = client(server);
    // The start page's first reads, in the order its components ask for them.
    const paths = ['opc.conversations', 'user.getUserProfile', 'fusionCompare.options', 'opc.library', 'opc.list', 'credits.getBalance',
      'runtime.choices', 'opc.catalog'];
    const answers = await Promise.all(paths.map(path => trpc.query(path)));

    // Every call gets its own answer back, whichever request carried it.
    expect(answers).toEqual(paths);
    const sent = server.requests.map(request => request.paths.join(',')).sort();
    expect(sent).toEqual([
      'fusionCompare.options,runtime.choices,opc.catalog',
      'opc.conversations',
      'user.getUserProfile,opc.library,opc.list,credits.getBalance',
    ].sort());
    expect(server.requests.find(request => request.paths[0] === 'opc.conversations')?.batched).toBe(false);
    // The same login header on every request.
    expect(server.requests.map(request => request.authorization)).toEqual(['Bearer test', 'Bearer test', 'Bearer test']);
  });

  it('sends a page without slow reads as before: one shared batch', async () => {
    const server = fakeServer();
    const trpc = client(server);
    await Promise.all(['user.getUserProfile', 'opc.library', 'credits.getBalance'].map(path => trpc.query(path)));
    expect(server.requests.map(request => request.paths.join(','))).toEqual(['user.getUserProfile,opc.library,credits.getBalance']);
  });

  it('keeps a mutation in the shared batch', async () => {
    const server = fakeServer();
    const trpc = client(server);
    await trpc.mutation('opc.workUiChange', { id: 'x' });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].paths).toEqual(['opc.workUiChange']);
  });
});
