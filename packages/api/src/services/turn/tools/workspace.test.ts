/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { NO_ENTITLEMENT } from '../agent/workspacePosts';
import { NO_ACCESS, workspaceTurnReader, type PostsAccess, type WorkspaceAccess } from './workspace';

const id = '00000000-0000-4000-8000-000000000001';
const posts = (windowDays: number): PostsAccess => ({ windowDays, benchmarks: false, review: false });
const empty = { kind: 'posts', data: { windowDays: 14, connections: [], posts: [] } };
function reader(access: Partial<WorkspaceAccess>, library?: (query: string) => Promise<{ text: string }>) {
  const rpc = vi.fn(async (name: string) => ({ error: null, data: name === 'posts_turn_read' ? empty : { kind: 'workspace_index', entries: [] } }));
  return { rpc, read: workspaceTurnReader({ rpc } as never, 'actor', 'session', { ...NO_ACCESS, sources: ['v1'], strategy: true, ...access }, library) };
}
const parsed = async (text: Promise<{ text: string }>) => JSON.parse((await text).text);

describe('read_source over the workspace and own posts (CORE-PATH-V2 V2-6 B)', () => {
  it('passes the version list settled before turn_open on every workspace read', async () => {
    const { rpc, read } = reader({});
    await read(id);
    expect(rpc).toHaveBeenCalledWith('workspace_turn_read', { p_actor_id: 'actor', p_session_id: 'session', p_query: id, p_allowed: ['v1'] });
  });

  it('lists the windows of the tier: free 14, Pro 14 and 30, Gold all three', async () => {
    for (const [days, ids] of [[0, ['my_posts:14']], [30, ['my_posts:14', 'my_posts:30']], [90, ['my_posts:14', 'my_posts:30', 'my_posts:90']]] as const) {
      const { entries } = await parsed(reader({ posts: posts(days) }).read(''));
      expect(entries.map((e: { id: string }) => e.id)).toEqual(ids);
    }
    expect((await parsed(reader({}).read(''))).entries).toEqual([]);
  });

  it('allowed: a window inside the tier is read with the tier\'s flags', async () => {
    const { rpc, read } = reader({ posts: { windowDays: 90, benchmarks: true, review: false } });
    expect(await parsed(read('my_posts:90'))).toMatchObject({ kind: 'my_posts', window_days: 14, status: 'not_connected' });
    expect(rpc).toHaveBeenCalledWith('posts_turn_read', { p_actor_id: 'actor', p_session_id: 'session', p_window_days: 90, p_review: false, p_benchmarks: true });
  });

  it('refused: a free member reads the note and nothing from the database; a window above the tier is refused', async () => {
    const free = reader({ posts: posts(0) });
    expect(await parsed(free.read('my_posts'))).toMatchObject({ status: 'no_entitlement', note: NO_ENTITLEMENT });
    expect(await parsed(free.read('my_posts:30'))).toEqual({ kind: 'unavailable' });
    expect(free.rpc).not.toHaveBeenCalled();
    const pro = reader({ posts: posts(30) });
    expect(await parsed(pro.read('my_posts:90'))).toEqual({ kind: 'unavailable' });
    expect(pro.rpc).not.toHaveBeenCalled();
    const off = reader({ posts: null });
    expect(await parsed(off.read('my_posts:14'))).toEqual({ kind: 'unavailable' });
    expect(off.rpc).not.toHaveBeenCalled();
  });

  it('refused: a third post read in one answer, and a strategy read with no room kept', async () => {
    const { rpc, read } = reader({ posts: posts(30) });
    await read('my_posts'); await read('my_posts:30');
    expect(await parsed(read('my_posts'))).toMatchObject({ kind: 'unavailable', reason: 'read_limit' });
    expect(rpc).toHaveBeenCalledTimes(2);
    const tight = reader({ strategy: false });
    expect(await parsed(tight.read(`strategy_report:${id}`))).toEqual({ kind: 'unavailable' });
    expect(tight.rpc).not.toHaveBeenCalled();
  });

  it('refused: a second strategy report in one answer (room was kept for one)', async () => {
    const { rpc, read } = reader({});
    await read(`strategy_report:${id}`);
    expect(await parsed(read(`strategy_report:${id}`))).toEqual({ kind: 'unavailable' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('library queries go to the library reader; without one nothing is read', async () => {
    const library = vi.fn(async () => ({ text: '{"kind":"library_index"}' }));
    expect(await parsed(reader({}, library).read('search:coffee'))).toEqual({ kind: 'library_index' });
    expect(library).toHaveBeenCalledWith('search:coffee');
    const none = reader({});
    expect(await parsed(none.read('library'))).toEqual({ kind: 'unavailable' });
    expect(none.rpc).not.toHaveBeenCalled();
  });
});
