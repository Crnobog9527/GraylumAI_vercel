/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef } from 'react';

/**
 * How often a page re-reads runtime.view (each read is one runtime_view database call).
 * While the server is advancing a turn the page did not stream itself, it re-reads quickly and
 * backs off the longer the turn runs. With no turn in progress it only checks occasionally (another
 * tab may start one). React Query skips interval reads while the tab is hidden, and the page reads
 * once more when it is shown again, so a background tab costs nothing.
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
 * set `busy.current` during render and the next interval uses it.
 */
export function useRuntimeViewPolling() {
  const since = useRef<{ key: string; at: number } | null>(null);
  const busy = useRef(false);
  return { busy, options: runtimeViewPollOptions(since, busy) };
}

/** The options behind useRuntimeViewPolling, with its two refs passed in. */
export function runtimeViewPollOptions(since: { current: { key: string; at: number } | null }, busy: { current: boolean }) {
  return {
    refetchInterval: (query: { state: { data: unknown } }) => {
      const view = query.state.data as RuntimeViewPollData;
      const key = progressingExecution(view) ?? (busy.current ? 'busy' : '');
      if (!key) { since.current = null; return RUNTIME_VIEW_IDLE_POLL_MS; }
      if (since.current?.key !== key) since.current = { key, at: Date.now() };
      return runtimeViewPollInterval(view, busy.current, Date.now() - since.current.at);
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  } as const;
}
