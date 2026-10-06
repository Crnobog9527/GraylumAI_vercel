/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { sessionRefreshLink } from './session-refresh-link';
import { SESSION_REFRESH_REQUIRED_MESSAGE, type SessionRefresher } from '@/lib/session-refresh';

const refusal = () => new Error(SESSION_REFRESH_REQUIRED_MESSAGE);
const op = (type: 'mutation' | 'query' = 'mutation') => ({ id: 1, type, path: 'opc.mentorTurnStream',
  input: { requestId: 'r-1' }, context: {}, signal: null }) as unknown as Operation;
function session(ok = true): SessionRefresher & { calls: string[] } {
  const calls: string[] = [];
  return { calls, ensureFresh: vi.fn(async () => { calls.push('ensure'); }),
    refresh: vi.fn(async () => { calls.push('refresh'); return ok; }) };
}
/** A downstream link whose n-th call produces the n-th outcome. */
function downstream(outcomes: Array<{ data?: unknown; error?: unknown }>) {
  const ops: Operation[] = [];
  const next = vi.fn((sent: Operation) => observable<{ result: { data?: unknown } }, unknown>(observer => {
    ops.push(sent);
    const outcome = outcomes[ops.length - 1]!;
    if (outcome.error) observer.error(outcome.error);
    else { observer.next({ result: { data: outcome.data } }); observer.complete(); }
    return () => undefined;
  }));
  return { next, ops };
}
function run(s: SessionRefresher, d: ReturnType<typeof downstream>, o = op()) {
  const link = sessionRefreshLink(s)({} as never);
  return new Promise<unknown>((resolve, reject) => {
    link({ op: o, next: d.next as never }).subscribe({ next: value => resolve((value.result as { data?: unknown }).data), error: reject });
  });
}
async function* stream(events: unknown[], error?: unknown) { for (const event of events) yield event; if (error) throw error; }
async function collect(iterable: unknown) { const out: unknown[] = []; for await (const event of iterable as AsyncIterable<unknown>) out.push(event); return out; }

describe('sessionRefreshLink', () => {
  it('checks the token before a mutation, not before a query', async () => {
    const s = session(), d = downstream([{ data: 1 }, { data: 2 }]);
    expect(await run(s, d)).toBe(1);
    expect(await run(s, d, op('query'))).toBe(2);
    expect(s.ensureFresh).toHaveBeenCalledTimes(1);
  });
  it('refreshes after the refusal and sends the same operation once more', async () => {
    const s = session(), d = downstream([{ error: refusal() }, { data: 'done' }]);
    expect(await run(s, d)).toBe('done');
    expect(s.calls).toEqual(['ensure', 'refresh']);
    expect(d.ops).toHaveLength(2);
    expect(d.ops[1]).toBe(d.ops[0]);
    expect((d.ops[1]!.input as { requestId: string }).requestId).toBe('r-1');
  });
  it('shows the original refusal when the refresh fails', async () => {
    const s = session(false), d = downstream([{ error: refusal() }]);
    await expect(run(s, d)).rejects.toThrow(SESSION_REFRESH_REQUIRED_MESSAGE);
    expect(d.ops).toHaveLength(1);
  });
  it('retries only once', async () => {
    const s = session(), d = downstream([{ error: refusal() }, { error: refusal() }, { data: 'never' }]);
    await expect(run(s, d)).rejects.toThrow(SESSION_REFRESH_REQUIRED_MESSAGE);
    expect(d.ops).toHaveLength(2);
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });
  it('leaves every other error alone', async () => {
    const s = session(), d = downstream([{ error: new Error('当前登录账号未获准访问此测试工作空间。') }]);
    await expect(run(s, d)).rejects.toThrow('未获准');
    expect(s.refresh).not.toHaveBeenCalled();
  });
  it('replaces a stream refused after admission with the replayed stream of the same request', async () => {
    const s = session();
    const d = downstream([{ data: stream([{ type: 'admitted', executionId: 'e-1' }], refusal()) },
      { data: stream([{ type: 'admitted', executionId: 'e-1' }, { type: 'result', result: { state: 'completed' } }]) }]);
    expect(await collect(await run(s, d))).toEqual([{ type: 'admitted', executionId: 'e-1' }, { type: 'admitted', executionId: 'e-1' },
      { type: 'result', result: { state: 'completed' } }]);
    expect(d.ops).toHaveLength(2);
    expect(d.ops[1]).toBe(d.ops[0]);
  });
  it('does not retry a stream twice, or when its refresh fails', async () => {
    const twice = downstream([{ data: stream([], refusal()) }, { data: stream([], refusal()) }, { data: stream(['never']) }]);
    await expect(collect(await run(session(), twice))).rejects.toThrow(SESSION_REFRESH_REQUIRED_MESSAGE);
    expect(twice.ops).toHaveLength(2);
    const failing = downstream([{ data: stream(['partial'], refusal()) }]);
    await expect(collect(await run(session(false), failing))).rejects.toThrow(SESSION_REFRESH_REQUIRED_MESSAGE);
    expect(failing.ops).toHaveLength(1);
    const other = downstream([{ data: stream([], new Error('其他错误')) }]);
    await expect(collect(await run(session(), other))).rejects.toThrow('其他错误');
    expect(other.ops).toHaveLength(1);
  });
});
