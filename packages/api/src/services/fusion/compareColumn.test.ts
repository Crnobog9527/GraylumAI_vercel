/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { POSITIONING_MARKER } from '../runtime/positioningFallback';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const s = vi.hoisted(() => ({ view: null as unknown, group: null as unknown, rpcs: [] as string[], owner: true }));
vi.mock('./compareAdmission', () => ({
  compareRpc: async (_admin: unknown, name: string) => { s.rpcs.push(name); return name === 'fusion_compare_dispatch_claim' ? s.owner : s.view; },
  replayCompareGroup: async () => { s.rpcs.push('replay'); return s.group; },
}));
import { streamCompareColumn, type ColumnDeps, type ColumnEvent } from './compareColumn';
import type { FusionCallOutcome } from './executor';

const frame = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
const view = (patch: Record<string, unknown> = {}, call: Record<string, unknown> | null = {}) => ({ compareId: id(1), requestId: id(2), sessionId: id(3),
  state: 'running', gateFallback: false, columns: [{ column: 0, runId: id(10), body: null,
    call: call === null ? null : { callId: id(20), state: 'prepared', dispatched: false, verdict: null, ...call } },
  { column: 1, runId: id(11), body: null, call: { callId: id(21), state: 'prepared', dispatched: false, verdict: null } }], ...patch });
const group = (index = 0) => ({ groupId: id(5), replayed: true, runs: [{ runId: id(10), index: 0, body: 'b0', call: { model: 'm0' } },
  { runId: id(11), index: 1, body: 'b1', call: { model: 'm1' } }].filter(run => run.index === index || index === -1) });
const collect = async (iterable: AsyncGenerator<ColumnEvent>) => { const out: ColumnEvent[] = []; for await (const event of iterable) out.push(event); return out; };
// The mock is typed loosely; the executor's signature is asserted through the recorded arguments.
const deps = (run: ReturnType<typeof vi.fn>): ColumnDeps => ({ admin: {} as SupabaseClient, actorId: id(50),
  executor: { run: run as unknown as ColumnDeps['executor']['run'] } });

beforeEach(() => { s.view = view(); s.group = group(-1); s.rpcs = []; s.owner = true; });

describe('compare column stream (FUSION-COMPARE §3.5)', () => {
  it('dispatches the column with its frozen request and call, streams the visible text in order, then reports the verdict', async () => {
    const run = vi.fn(async (_run: unknown, _claimed: unknown, _judge: unknown, onChunk?: (frame: string) => void) => {
      onChunk?.(frame('你')); onChunk?.(JSON.stringify({ usage: { total_tokens: 1 } })); onChunk?.(frame('好'));
      return { state: 'judged', verdict: 'usable', text: '你好' } as FusionCallOutcome;
    });
    const events = await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }));
    expect(events).toEqual([{ type: 'delta', text: '你' }, { type: 'delta', text: '好' }, { type: 'done', verdict: 'usable' }]);
    expect(run).toHaveBeenCalledTimes(1);
    const [admitted, claimed, judge, , refuse] = run.mock.calls[0]! as unknown[];
    expect(admitted).toMatchObject({ runId: id(10), index: 0, body: 'b0' });
    expect(claimed).toEqual({ runId: id(10), id: id(20), state: 'prepared', fresh: false });
    expect((judge as (text: string) => string)('any text')).toBe('usable');
    expect(refuse).toBeUndefined(); // no fallback rule on this column
  });
  it('a request that does not win the dispatch claim never enters the executor: it answers already', async () => {
    s.owner = false;
    const run = vi.fn(async () => ({ state: 'judged', verdict: 'usable' }) as FusionCallOutcome);
    expect(await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).toEqual([{ type: 'already', verdict: null }]);
    expect(run).not.toHaveBeenCalled();
    expect(s.rpcs).toContain('fusion_compare_dispatch_claim');
  });
  it('gives the dispatch claim back when the connection was confirmed never started, and only then', async () => {
    const noStart = vi.fn(async () => ({ state: 'pending', reason: 'not_started' }) as FusionCallOutcome);
    expect(await collect(streamCompareColumn(deps(noStart), { compareId: id(1), column: 0 }))).toEqual([{ type: 'pending', reason: 'not_started' }]);
    expect(s.rpcs).toContain('fusion_compare_dispatch_release');
    s.rpcs = [];
    const unreadable = vi.fn(async () => ({ state: 'pending', reason: 'response_unreadable' }) as FusionCallOutcome);
    await collect(streamCompareColumn(deps(unreadable), { compareId: id(1), column: 0 }));
    expect(s.rpcs).not.toContain('fusion_compare_dispatch_release');
  });
  it('dispatches the other column, not a neighbour: columns are independent requests', async () => {
    const run = vi.fn(async () => ({ state: 'judged', verdict: 'usable' }) as FusionCallOutcome);
    await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 1 }));
    expect((run.mock.calls[0]! as unknown[])[0]).toMatchObject({ runId: id(11), index: 1 });
    expect((run.mock.calls[0]! as unknown[])[1]).toMatchObject({ id: id(21) });
  });
  it('never dispatches a column that was dispatched, judged or already has an answer; it says so instead', async () => {
    const run = vi.fn();
    for (const call of [{ dispatched: true }, { verdict: 'usable' }, { verdict: 'no_delivery' }]) {
      s.view = view({}, call);
      expect(await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).toEqual([{ type: 'already', verdict: (call as { verdict?: string }).verdict ?? null }]);
    }
    s.view = { ...view(), columns: [{ ...view().columns[0]!, body: 'answer' }] };
    expect((await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 })))[0]).toMatchObject({ type: 'already' });
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses an unknown or foreign compare, an ended one, an unknown column and a run the group does not have', async () => {
    const run = vi.fn();
    s.view = null;
    await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).rejects.toThrow('FUSION_COMPARE_DENIED');
    for (const state of ['stopped', 'refused', 'admitting']) {
      s.view = view({ state });
      await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).rejects.toThrow('FUSION_COMPARE_ENDED');
    }
    s.view = view();
    await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 7 }))).rejects.toThrow('FUSION_COMPARE_DENIED');
    s.view = view({}, null);
    await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).rejects.toThrow('FUSION_COMPARE_DENIED');
    s.view = view(); s.group = null;
    await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).rejects.toThrow('FUSION_COMPARE_DENIED');
    s.group = group(1); // the group has no run for column 0
    await expect(collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).rejects.toThrow('FUSION_COMPARE_DENIED');
    expect(run).not.toHaveBeenCalled();
  });
  it('a column with the fallback rule shows nothing when it answers with the marker, and asks the executor to refuse it before saving', async () => {
    s.view = view({ gateFallback: true });
    const run = vi.fn(async (_r: unknown, _c: unknown, _j: unknown, onChunk?: (frame: string) => void, refuse?: (text: string) => boolean) => {
      onChunk?.(frame(POSITIONING_MARKER.slice(0, 8))); onChunk?.(frame(POSITIONING_MARKER.slice(8)));
      expect(refuse?.(POSITIONING_MARKER)).toBe(true);
      return { state: 'judged', verdict: 'no_delivery' } as FusionCallOutcome;
    });
    const events = await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }));
    expect(events).toEqual([{ type: 'done', verdict: 'no_delivery' }]);
  });
  it('a column with the fallback rule that answers normally shows its whole answer', async () => {
    s.view = view({ gateFallback: true });
    const run = vi.fn(async (_r: unknown, _c: unknown, _j: unknown, onChunk?: (frame: string) => void) => {
      onChunk?.(frame('三个')); onChunk?.(frame('开头建议'));
      return { state: 'judged', verdict: 'usable' } as FusionCallOutcome;
    });
    const events = await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }));
    expect(events.filter(event => event.type === 'delta').map(event => (event as { text: string }).text).join('')).toBe('三个开头建议');
    expect(events.at(-1)).toEqual({ type: 'done', verdict: 'usable' });
  });
  it('reports an unfinished call as pending with the reason, and a provider rejection as no_delivery', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ state: 'pending', reason: 'response_unreadable' })
      .mockResolvedValueOnce({ state: 'judged', verdict: 'no_delivery' });
    expect(await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).toEqual([{ type: 'pending', reason: 'response_unreadable' }]);
    expect(await collect(streamCompareColumn(deps(run), { compareId: id(1), column: 0 }))).toEqual([{ type: 'done', verdict: 'no_delivery' }]);
  });
  it('passes an executor failure (rate limit, time budget) to the caller after the text it already sent', async () => {
    const run = vi.fn(async (_r: unknown, _c: unknown, _j: unknown, onChunk?: (frame: string) => void) => {
      onChunk?.(frame('半句')); throw new Error('RATE_LIMITED');
    });
    const seen: ColumnEvent[] = [];
    await expect((async () => { for await (const event of streamCompareColumn(deps(run), { compareId: id(1), column: 0 })) seen.push(event); })())
      .rejects.toThrow('RATE_LIMITED');
    expect(seen).toEqual([{ type: 'delta', text: '半句' }]);
  });
});
