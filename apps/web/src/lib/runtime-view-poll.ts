/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef } from 'react';

/**
 * How often a page re-reads runtime.view (each read is one runtime_view database call).
 * While the server is advancing a turn the page did not stream itself, it re-reads quickly and
 * backs off the longer the turn runs. With no turn in progress it only checks occasionally (another
 * tab may start one). React Query skips interval reads while the tab is hidden, and the page reads
 * once more when it is shown again (even within the 30 s staleTime), so a background tab costs nothing.
 * While this page's own stream is open the stream carries the progress, so the page does not poll at all
 * (DB-PERF 5b); when the stream ends or breaks the page reads once and the polling above takes over again.
 */
export const RUNTIME_VIEW_ACTIVE_POLL_MS = [5000, 8000, 12000] as const;
/** The active interval moves to the next step after this long (ms) on the same execution. */
export const RUNTIME_VIEW_BACKOFF_AFTER_MS = [30_000, 120_000] as const;
export const RUNTIME_VIEW_IDLE_POLL_MS = 60_000;
/** States the server is still advancing by itself (same as the positioning page's step recovery). */
const PROGRESSING_STATES = ['prepared', 'running'];

export type RuntimeViewPollData = {
  activeExecution?: string | null;
  executions?: ReadonlyArray<{ executionId: string; state: string }> | null;
} | null | undefined;

/** The active execution while the server is still advancing it, otherwise null. */
export function progressingExecution(view: RuntimeViewPollData): string | null {
  const id = view?.activeExecution;
  if (!id) return null;
  const active = view?.executions?.find(execution => execution.executionId === id);
  return !active || PROGRESSING_STATES.includes(active.state) ? id : null;
}

/** pageBusy: this page is sending or streaming a turn whose execution may not be in the view yet. */
export function runtimeViewPollInterval(view: RuntimeViewPollData, pageBusy: boolean, activeForMs: number): number {
  if (!pageBusy && !progressingExecution(view)) return RUNTIME_VIEW_IDLE_POLL_MS;
  const step = RUNTIME_VIEW_BACKOFF_AFTER_MS.filter(after => activeForMs >= after).length;
  return RUNTIME_VIEW_ACTIVE_POLL_MS[step];
}

/**
 * Query options for runtime.view; the backoff restarts for each new busy period or execution.
 * `busy` is a ref because pages know whether they are sending only after the view query is declared;
 * pages report it with useRuntimeViewBusy, which also re-reads at once when an idle page starts sending.
 */
export function useRuntimeViewPolling() {
  const since = useRef<{ key: string; at: number } | null>(null);
  const busy = useRef(false);
  const streaming = useRef<string | null>(null);
  return { busy, streaming, options: runtimeViewPollOptions(since, busy, streaming) };
}

/** The options behind useRuntimeViewPolling, with its two refs passed in. */
export function runtimeViewPollOptions(
  since: { current: { key: string; at: number } | null }, busy: { current: boolean }, streaming: { current: string | null } = { current: null },
) {
  return {
    refetchInterval: (query: { state: { data: unknown } }) => {
      // The open stream reports progress itself; when it closes useRuntimeViewStreaming reads once and re-arms this.
      // Only once the view lists the streamed execution: until then the page needs it (Stop button, progress).
      const streamed = streaming.current;
      const view0 = query.state.data as RuntimeViewPollData;
      if (streamed && view0?.executions?.some(execution => execution.executionId === streamed)) return false as const;
      const view = query.state.data as RuntimeViewPollData;
      const key = progressingExecution(view) ?? (busy.current ? 'busy' : '');
      if (!key) { since.current = null; return RUNTIME_VIEW_IDLE_POLL_MS; }
      if (since.current?.key !== key) since.current = { key, at: Date.now() };
      return runtimeViewPollInterval(view, busy.current, Date.now() - since.current.at);
    },
    refetchIntervalInBackground: false,
    // 'always': the shared 30 s staleTime would otherwise skip the read on a quick return.
    refetchOnWindowFocus: 'always',
  } as const;
}

/**
 * Records whether the page is sending. Changing a ref does not reschedule an interval TanStack Query
 * already computed, so an idle page (60 s timer) that starts sending re-reads now; that read schedules
 * the next one with the busy interval.
 */
export function markRuntimeViewBusy(busy: { current: boolean }, next: boolean, refetch: () => unknown) {
  const was = busy.current;
  busy.current = next;
  if (next && !was) void refetch();
}

export function useRuntimeViewBusy(polling: { busy: { current: boolean } }, busy: boolean, refetch: () => unknown, enabled: boolean) {
  const latest = useRef(refetch);
  useEffect(() => { latest.current = refetch; });
  useEffect(() => { markRuntimeViewBusy(polling.busy, busy, () => enabled && latest.current()); }, [busy, enabled, polling.busy]);
}

/** Records the execution this page's own stream carries (null when none); a closing stream re-reads once so polling can resume. */
export function markRuntimeViewStreaming(streaming: { current: string | null }, next: string | null, refetch: () => unknown) {
  const was = streaming.current;
  streaming.current = next;
  if (was && !next) void refetch();
}

export function useRuntimeViewStreaming(
  polling: { streaming: { current: string | null } }, streaming: string | null, refetch: () => unknown, enabled: boolean,
) {
  const latest = useRef(refetch);
  useEffect(() => { latest.current = refetch; });
  useEffect(() => { markRuntimeViewStreaming(polling.streaming, streaming, () => enabled && latest.current()); }, [streaming, enabled, polling.streaming]);
}

/** A turn that was progressing is not any more (finished, paused or stopped). */
export function turnSettled(was: string | null, now: string | null): boolean {
  return Boolean(was && !now);
}

/**
 * Calls `onSettled` when a turn this view showed as progressing is no longer progressing. A turn another
 * tab started or one resumed after a reload finishes without this page's stream, so nothing else re-reads
 * the balance that was shown while credits were held for it.
 */
export function useRuntimeViewSettled(view: RuntimeViewPollData, onSettled: () => void) {
  const was = useRef<string | null>(null);
  const latest = useRef(onSettled);
  useEffect(() => { latest.current = onSettled; });
  const now = progressingExecution(view);
  useEffect(() => {
    if (turnSettled(was.current, now)) latest.current();
    was.current = now;
  }, [now]);
}
