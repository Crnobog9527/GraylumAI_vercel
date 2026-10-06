/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TRPCLink } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import { observable, type Unsubscribable } from '@trpc/server/observable';
import { isSessionRefreshRequired, type SessionRefresher } from '@/lib/session-refresh';

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value;

/**
 * Keeps Runtime requests from failing for a token that is merely about to expire.
 *
 * - Before every mutation (all Runtime entries are mutations), refresh a token that is close
 *   to expiry.
 * - When Runtime still refuses with "登录会话剩余时间不足", refresh once and send the same
 *   operation again. Its input is unchanged, so it carries the original requestId or
 *   executionId and the server replays it instead of admitting or charging anything new.
 *   Streamed turns report the refusal inside the stream (after `admitted`), so the stream
 *   is replaced by the replayed one. Only one retry per operation; when the refresh itself
 *   fails, the original refusal (which asks the user to log in again) is shown.
 */
export function sessionRefreshLink<TRouter extends AnyRouter>(session: SessionRefresher): TRPCLink<TRouter> {
  return () => ({ op, next }) => observable(observer => {
    let retried = false, closed = false;
    let subscription: Unsubscribable | null = null;

    /** One more run of the same operation, resolved to its streamed data. */
    const replayStream = () => new Promise<AsyncIterable<unknown>>((resolve, reject) => {
      const replay = next(op).subscribe({
        next(value) {
          const data = (value.result as { data?: unknown }).data;
          if (isAsyncIterable(data)) resolve(data);
          else reject(new Error('Session refresh replay returned no stream'));
        },
        error: reject,
      });
      if (closed) replay.unsubscribe();
    });

    async function* guarded(stream: AsyncIterable<unknown>): AsyncGenerator<unknown> {
      try {
        yield* stream;
      } catch (error) {
        if (retried || !isSessionRefreshRequired(error)) throw error;
        retried = true;
        if (!(await session.refresh())) throw error;
        yield* await replayStream();
      }
    }

    const run = () => {
      subscription = next(op).subscribe({
        next(value) {
          const result = value.result as { data?: unknown };
          observer.next(isAsyncIterable(result.data) ? { ...value, result: { ...result, data: guarded(result.data) } } as typeof value : value);
        },
        error(error) {
          if (retried || !isSessionRefreshRequired(error)) { observer.error(error); return; }
          retried = true;
          void session.refresh().then(ok => {
            if (closed) return;
            if (ok) run(); else observer.error(error);
          });
        },
        complete() { observer.complete(); },
      });
    };

    void (op.type === 'mutation' ? session.ensureFresh() : Promise.resolve()).then(() => { if (!closed) run(); });
    return () => { closed = true; subscription?.unsubscribe(); };
  });
}
