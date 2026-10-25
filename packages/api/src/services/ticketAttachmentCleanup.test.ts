/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runTicketAttachmentCleanup } from './ticketAttachmentCleanup';

function setup(pages: unknown[][], removeResult = (names: string[]) => ({ data: names.map(name => ({ name })), error: null })) {
  const runs: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async () => ({ data: pages.shift() ?? [], error: null }));
  const remove = vi.fn(async (names: string[]) => removeResult(names));
  const from = vi.fn(() => ({
    insert: (row: Record<string, unknown>) => { runs.push(row); return { select: () => ({ single: async () => ({ data: { id: 'run' }, error: null }) }) }; },
    update: (row: Record<string, unknown>) => { runs.push(row); return { eq: async () => ({ error: null }) }; },
  }));
  const client = { rpc, from, storage: { from: vi.fn(() => ({ remove })) } } as unknown as SupabaseClient;
  return { client, rpc, remove, runs };
}
const names = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}/${i}.png`);

describe('ticket attachment cleanup', () => {
  it('removes listed orphans through Storage and records counts only', async () => {
    const f = setup([names(2)]);
    expect(await runTicketAttachmentCleanup(f.client)).toEqual({ removed: 2, failed: 0, more: false });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('ticket_attachment_orphans', { p_limit: 100 });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(names(2));
    expect(f.runs.at(-1)).toMatchObject({ status: 'success', summary: { removed: 2, failed: 0, more: false } });
    expect(JSON.stringify(f.runs)).not.toContain('.png');
  });
  it('continues full batches and stops at the batch cap', async () => {
    const f = setup(Array.from({ length: 7 }, (_, i) => names(100, `b${i}`)));
    expect(await runTicketAttachmentCleanup(f.client)).toEqual({ removed: 500, failed: 0, more: true });
    expect(f.remove).toHaveBeenCalledTimes(5);
  });
  it('stops when nothing was removed instead of looping on the same names', async () => {
    const f = setup([names(100), names(100)], () => ({ data: null, error: { message: 'down' } } as never));
    expect(await runTicketAttachmentCleanup(f.client)).toEqual({ removed: 0, failed: 100, more: true });
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.runs.at(-1)).toMatchObject({ status: 'error' });
  });
  it('records an error run when orphans cannot be listed', async () => {
    const f = setup([]); f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } } as never);
    await expect(runTicketAttachmentCleanup(f.client)).rejects.toThrow('TICKET_ATTACHMENTS_CLEANUP_FAILED');
    expect(f.runs.at(-1)).toMatchObject({ status: 'error', error: 'TICKET_ATTACHMENTS_CLEANUP_FAILED' });
    expect(f.remove).not.toHaveBeenCalled();
  });
});
