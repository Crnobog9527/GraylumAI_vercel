/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ storage: vi.fn() }));
vi.mock('../scheduledJobRuns', () => ({ startScheduledJobRun: vi.fn(async () => 'run-1'), finishScheduledJobRun: vi.fn() }));
vi.mock('./storage', () => ({ libraryStorage: mocks.storage }));
import { cleanupLibrary, LIBRARY_CRON_BATCH, runLibraryCleanup } from './cleanup';
import type { LibraryStorage } from './storage';

const a = '11111111-1111-4111-8111-111111111111';
// Deleted documents whose objects are already gone and whose upload guard has passed: each one is a full visit.
const rows = Array.from({ length: 100 }, (_, i) => {
  const document = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
  return { actor_id: a, document_id: document, original_path: `${a}/${document}/original`, text_path: null,
    status: 'deleting', closed: false, cleanup: true, original_guard_until: new Date(0).toISOString(), text_guard_until: null };
});
let rpc: ReturnType<typeof vi.fn>;
let storage: LibraryStorage;
beforeEach(() => {
  rpc = vi.fn(async (name: string, args: { n?: number }) => {
    if (name === 'library_cleanup_candidates') return { data: rows.slice(0, args.n) };
    if (name === 'library_cleanup_backlog') return { data: { pending: 0, overdue: 0, oldestDeletedAt: null } };
    if (name === 'runtime_library_propagate') return { data: { processed: 0, waiting: 0 } };
    if (name === 'library_paths_claimed') return { data: [] };
    return { data: true };
  });
  storage = { absent: vi.fn(async () => true), remove: vi.fn(), scan: vi.fn(async () => ({ paths: [], cursor: null })) } as never;
  mocks.storage.mockReturnValue(storage);
});
function client() {
  const previous = { data: { summary: {} }, error: null };
  const query = { select: () => query, eq: () => query, neq: () => query, not: () => query, order: () => query,
    limit: () => query, maybeSingle: async () => previous };
  return { rpc, from: () => query } as unknown as SupabaseClient;
}

it('the 5-minute cron asks for 100 rows, the most the candidate function allows', async () => {
  expect(LIBRARY_CRON_BATCH).toBe(100);
  const result = await runLibraryCleanup(client());
  expect(rpc).toHaveBeenCalledWith('library_cleanup_candidates', { a: null, n: 100, did: null });
  expect(result).toMatchObject({ checked: 100, released: 100, failed: 0, budgetExhausted: false });
});

it('a batch of 100 is visited in full within the time budget and every row is observed', async () => {
  const result = await cleanupLibrary(client(), { limit: 100, storage });
  expect(result).toMatchObject({ checked: 100, released: 100, failed: 0, budgetExhausted: false });
  expect(rpc.mock.calls.filter(call => call[0] === 'library_cleanup_observe')).toHaveLength(100);
  expect(rpc.mock.calls.filter(call => call[0] === 'library_cleanup_touch')).toHaveLength(100);
});

it('other callers keep their own smaller batches', async () => {
  await cleanupLibrary(client(), { actorId: a, limit: 4, budgetMs: 5000, storage });
  expect(rpc).toHaveBeenCalledWith('library_cleanup_candidates', { a, n: 4, did: null });
  await cleanupLibrary(client(), { storage });
  expect(rpc).toHaveBeenLastCalledWith('library_cleanup_backlog', { a: null });
  expect(rpc).toHaveBeenCalledWith('library_cleanup_candidates', { a: null, n: 50, did: null });
});
