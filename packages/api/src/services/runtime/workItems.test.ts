/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readWorkItems, withWorkItems} from './workItems';

const database = (rpc: () => Promise<unknown>) => ({rpc: vi.fn(rpc)}) as unknown as SupabaseClient;
const row = {kind: 'positioning', state: 'done', label: '读了你确认的定位', id: 'c1'};

describe('readWorkItems', () => {
  it('returns the rows per answer and drops empty or malformed entries', async () => {
    const db = database(async () => ({data: {a: [row], b: [], c: 'x'}, error: null}));
    expect(await readWorkItems(db, 'actor', 'session')).toEqual({a: [row]});
    expect((db.rpc as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['runtime_work_items', {p_actor_id: 'actor', p_session_id: 'session'}]);
  });
  it.each([
    ['an rpc error', async () => ({data: null, error: {code: 'PGRST202', message: 'missing'}})],
    ['a thrown error', async () => { throw new Error('timeout'); }],
    ['an array', async () => ({data: [row], error: null})],
    ['nothing', async () => ({data: null, error: null})],
  ])('never breaks the view: %s gives no rows', async (_name, rpc) => {
    expect(await readWorkItems(database(rpc as () => Promise<unknown>), 'actor', 'session')).toEqual({});
  });
});

describe('withWorkItems', () => {
  it('attaches rows only to the answers that have them', () => {
    const view = {sessionId: 's', executions: [{executionId: 'a', state: 'completed'}, {executionId: 'b'}, null]};
    const merged = withWorkItems(view, {a: [row]});
    expect(merged.executions).toEqual([{executionId: 'a', state: 'completed', workItems: [row]}, {executionId: 'b'}, null]);
    expect(merged.sessionId).toBe('s');
  });
  it('returns the very same view when there is nothing to attach', () => {
    const view = {executions: [{executionId: 'a'}]};
    expect(withWorkItems(view, {})).toBe(view);
  });
});
