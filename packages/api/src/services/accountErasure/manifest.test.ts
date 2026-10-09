/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createErasureAttachmentManifest } from './manifest';
import { createErasureStorageAdapter } from './storage';

const actor = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const ticket = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const path = `${admin}/reply.png`;
const signal = () => new AbortController().signal;
function setup(options: { bad?: string; history?: boolean } = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    tickets: [{ id: ticket, user_id: actor, attachments: [`${actor}/own.png`] }],
    ticket_replies: [{ id: ticket, ticket_id: ticket, user_id: admin, attachments: [path] }],
  };
  const queries: string[] = [];
  const client = { from(table: string) {
    let after = ''; let limit = 1;
    const query = {
      select(columns: string, config: unknown) { queries.push(`${table}:${columns}`); expect(config).toEqual({ count: 'exact' }); return query; },
      order(column: string) { expect(column).toBe('id'); return query; },
      limit(value: number) { limit = value; return query; },
      gt(column: string, value: string) { expect(column).toBe('id'); after = value; return query; },
      async abortSignal(input: AbortSignal) {
        expect(input).toBeInstanceOf(AbortSignal);
        if (options.bad === 'hang') return new Promise(() => {});
        const rows = data[table].filter(row => String(row.id) > after).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const page = rows.slice(0, limit);
        return { data: options.bad === 'missing' ? [] : options.bad === 'duplicate' ? [...page, ...page] : page,
          count: options.bad === 'no_count' ? null : rows.length,
          error: options.bad === 'error' ? { message: 'private detail' } : null };
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  const verifyRetainedHistory = options.history === false ? undefined : vi.fn(async () => {});
  const manifest = createErasureAttachmentManifest({ client, verifyRetainedHistory, limits: { pageSize: 1, timeoutMs: 30 } });
  return { manifest, data, queries, client };
}
const list = (f: ReturnType<typeof setup>, cursor: string | null = null) =>
  f.manifest.list({ profileId: actor, cursor, limit: 1, signal: signal() });
it('keeps administrator ownership and stable path pagination; classifies across every subject', async () => {
  const f = setup();
  const first = await list(f) as { items: { path: string }[]; nextCursor: string };
  expect(first.items[0].path).toBe(`${actor}/own.png`);
  expect((await list(f, first.nextCursor))).toEqual({ items: [{ path, uploaderId: admin, subjectId: actor }], nextCursor: null });
  expect(await f.manifest.classify({ profileId: actor, paths: [path], signal: signal() }))
    .toEqual([{ path, state: 'unknown' }]);
  f.data.tickets.push({ id: second, user_id: other, attachments: [] });
  f.data.ticket_replies.push({ id: second, ticket_id: second, user_id: admin, attachments: [path] });
  expect(await f.manifest.classify({ profileId: actor, paths: [path, `${actor}/orphan.png`], signal: signal() }))
    .toEqual([{ path, state: 'shared' }, { path: `${actor}/orphan.png`, state: 'unreferenced' }]);
  expect(f.queries.every(query => !/content|description|email|is_deleted/.test(query))).toBe(true);
});
for (const bad of ['missing', 'duplicate', 'no_count', 'error', 'hang']) {
  it(`refuses ${bad} without leaking raw details or treating the inventory as empty`, async () => {
    const f = setup({ bad });
    await expect(list(f)).rejects.toThrow('ERASURE_MANIFEST_UNKNOWN');
  });
}
it('does not infer historical completeness from current empty tables', async () => {
  const f = setup({ history: false }); f.data.tickets = []; f.data.ticket_replies = [];
  await expect(list(f)).rejects.toThrow('ERASURE_MANIFEST_UNKNOWN');
  expect(f.queries).toEqual([]);
});
it('refuses abort, over-budget inventories, unknown parents and noncanonical raw references', async () => {
  const f = setup();
  const controller = new AbortController(); controller.abort();
  await expect(f.manifest.list({ profileId: actor, cursor: null, limit: 1, signal: controller.signal })).rejects.toThrow();
  f.data.ticket_replies[0].ticket_id = second;
  await expect(list(f)).rejects.toThrow();
  f.data.ticket_replies[0].ticket_id = ticket;
  for (const bad of ['https://private.invalid/x', `${other}/foreign.png`, 1, '../x']) {
    f.data.ticket_replies[0].attachments = [bad];
    await expect(list(f)).rejects.toThrow('ERASURE_MANIFEST_UNKNOWN');
  }
  const capped = createErasureAttachmentManifest({ client: f.client, verifyRetainedHistory: async () => {}, limits: { maxRows: 1 } });
  f.data.tickets.push({ id: second, user_id: other, attachments: [] });
  await expect(capped.list({ profileId: actor, cursor: null, limit: 1, signal: signal() })).rejects.toThrow();
});
it('composes with Storage: shared/unknown administrator objects are never removed', async () => {
  const f = setup();
  f.data.tickets.push({ id: second, user_id: other, attachments: [] });
  f.data.ticket_replies.push({ id: second, ticket_id: second, user_id: admin, attachments: [path] });
  const remove = vi.fn(async () => {});
  const storage = { listPrefix: async () => ({ paths: [], nextAfterPath: null }), remove,
    getState: async () => 'absent' };
  const adapter = createErasureStorageAdapter({ storage, manifest: f.manifest });
  expect(await adapter.cleanSubject(actor)).toMatchObject({ complete: false, manualReview: 1 });
  expect(remove).not.toHaveBeenCalled();
  f.data.ticket_replies[0].attachments = ['invalid'];
  expect(await adapter.cleanSubject(actor)).toMatchObject({ complete: false });
  expect(remove).not.toHaveBeenCalled();
});
it('uses the locked Supabase SDK exact counts and keyset filters over synthetic HTTP only', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const seen: string[] = [];
  const client = createClient('https://manifest.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe('https://manifest.invalid');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      expect(target.searchParams.get('order')).toBe('id.asc');
      expect(target.searchParams.get('limit')).toBe('1');
      seen.push(target.pathname);
      const rows = target.pathname.endsWith('/tickets')
        ? [{ id: ticket, user_id: actor, attachments: [] }, { id: second, user_id: other, attachments: [] }]
        : [{ id: ticket, ticket_id: ticket, user_id: admin, attachments: [path] }];
      const after = target.searchParams.get('id');
      if (after) expect(after).toBe(`gt.${ticket}`);
      const remaining = rows.filter(row => !after || row.id > after.slice(3));
      return new Response(JSON.stringify(remaining.slice(0, 1)), { status: 200,
        headers: { 'content-type': 'application/json', 'content-range': `0-0/${remaining.length}` } });
    } },
  });
  const manifest = createErasureAttachmentManifest({ client, limits: { pageSize: 1 }, verifyRetainedHistory: async () => {} });
  expect(await manifest.list({ profileId: actor, cursor: null, limit: 10, signal: signal() }))
    .toEqual({ items: [{ path, uploaderId: admin, subjectId: actor }], nextCursor: null });
  expect(seen).toEqual(['/rest/v1/tickets', '/rest/v1/tickets', '/rest/v1/ticket_replies']);
});
