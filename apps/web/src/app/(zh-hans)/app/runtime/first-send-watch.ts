/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { captureMessage } from '@sentry/nextjs';
import { useEffect, useRef } from 'react';

/*
 * A watch, not a fix (controller 2026-11-04): a message sent from the start page is sent again by the conversation page once four
 * conditions hold (the box has the text, the conversation was read, nothing is sending, the start page's marker matches ?request=).
 * In rare simulated runs no turn was ever asked for. If the page came with the marker and has not asked for a turn after
 * FIRST_SEND_WATCH_MS, one Sentry event says which conditions held. Nothing is retried and nothing on the page changes.
 * The event carries only 0/1 flags and two durations (the Sentry scrubber keeps exactly these integers): no text, no ids.
 */
export const FIRST_SEND_STALLED = 'RUNTIME_FIRST_SEND_STALLED';
export const FIRST_SEND_WATCH_MS = 15_000;
export type FirstSendState = { hasInput: boolean; hasView: boolean; notBusy: boolean; markerMatches: boolean };
type Report = (extra: Record<string, number>) => void;

export const markerKey = (sessionId: string) => 'opc-runtime-send:' + sessionId;
/** Whether the start page's marker for this conversation is there and matches the address's request id. */
export function markerMatches(storage: Pick<Storage, 'getItem'>, sessionId: string, href: string): boolean {
  const marker = storage.getItem(markerKey(sessionId));
  return Boolean(marker) && new URL(href).searchParams.get('request') === marker;
}

const sentryReport: Report = extra => captureMessage(FIRST_SEND_STALLED, {
  level: 'warning', fingerprint: [FIRST_SEND_STALLED], tags: { category: 'runtime', code: FIRST_SEND_STALLED }, extra });

/*
 * When the watch started is kept in this tab's session storage, so a page that mounts again after the marker was consumed (and so
 * would not send) still reports on time. Cleared by the first send; after the report it says so: one event at most per conversation
 * and tab.
 */
const watchKey = (sessionId: string) => 'opc-runtime-send-watch:' + sessionId;
const REPORTED = 'reported';
export function firstSendDone(storage: Pick<Storage, 'getItem' | 'removeItem'>, sessionId: string) {
  // A report stays recorded: one event per conversation and tab, and a run can see that none was raised.
  try { if (storage.getItem(watchKey(sessionId)) !== REPORTED) storage.removeItem(watchKey(sessionId)); } catch { /* nothing was armed */ }
}

export type FirstSendWatch = {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; sessionId: string; href: () => string; now: () => number;
  /** Whether the page has asked for the turn. */
  sent: () => boolean;
  /** The three conditions the page holds; the marker is read here. */
  state: () => Omit<FirstSendState, 'markerMatches'>;
  pageAgeMs: () => number; report?: Report; delayMs?: number;
};

/** Arms the watch when the page came with the start page's marker, or one is already running for this conversation; returns the cancel. */
export function startFirstSendWatch(watch: FirstSendWatch): () => void {
  const { storage, sessionId, delayMs = FIRST_SEND_WATCH_MS } = watch;
  let started: number;
  try {
    const kept = storage.getItem(watchKey(sessionId));
    if (kept === REPORTED) return () => undefined;
    const running = Number(kept);
    const marker = markerMatches(storage, sessionId, watch.href());
    // A page mounting again after the marker was taken (it will not send) keeps the first page's clock. With the marker still there
    // (the user came back before it was sent) this page will send: its clock starts now. One left long ago is dropped.
    if (running > 0 && !marker && watch.now() - running < 2 * delayMs) started = running;
    else {
      firstSendDone(storage, sessionId);
      if (!marker) return () => undefined;
      started = watch.now();
      storage.setItem(watchKey(sessionId), String(started));
    }
  } catch { return () => undefined; }
  const timer = setTimeout(() => {
    if (watch.sent()) { firstSendDone(storage, sessionId); return; }
    const held = watch.state(), bit = (value: boolean) => (value ? 1 : 0);
    let matches = false;
    try { matches = markerMatches(storage, sessionId, watch.href()); } catch { /* unreadable: reported as not matching */ }
    try { storage.setItem(watchKey(sessionId), REPORTED); } catch { /* storage unavailable: a later mount cannot arm either */ }
    (watch.report ?? sentryReport)({ hasInput: bit(held.hasInput), hasView: bit(held.hasView), notBusy: bit(held.notBusy),
      markerMatches: bit(matches), pageAgeMs: Math.max(0, Math.round(watch.pageAgeMs())),
      waitedMs: Math.max(0, Math.round(watch.now() - started)) });
  }, Math.max(0, started + delayMs - watch.now()));
  return () => clearTimeout(timer);
}

/** The conversation page's wiring. Call it before the page's first-send effect, so it sees the marker before that effect takes it. */
export function useFirstSendWatch(sessionId: string, sent: { current: boolean }, conditions: Omit<FirstSendState, 'markerMatches'>) {
  const latest = useRef(conditions);
  latest.current = conditions;
  useEffect(() => startFirstSendWatch({ storage: sessionStorage, sessionId, href: () => location.href, now: () => Date.now(),
    sent: () => sent.current, state: () => latest.current, pageAgeMs: () => performance.now() }), [sessionId, sent]);
}
