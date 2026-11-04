/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
import { FIRST_SEND_STALLED, FIRST_SEND_WATCH_MS, firstSendDone, markerKey, startFirstSendWatch, type FirstSendWatch } from './first-send-watch';
import { scrubErrorEvent } from '@/lib/sentry-scrub';

const SESSION = '11111111-2222-4333-8444-555555555555', REQUEST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HREF = `https://app.example.test/app/runtime?session=${SESSION}&request=${REQUEST}`;

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k), map };
}
const ready = { hasInput: true, hasView: true, notBusy: true };

function watch(storage: ReturnType<typeof memoryStorage>, sent: { current: boolean }, extra: Partial<FirstSendWatch> = {}) {
  return startFirstSendWatch({ storage, sessionId: SESSION, href: () => HREF, now: () => Date.now(), sent: () => sent.current,
    state: () => ready, pageAgeMs: () => 1234.4, ...extra });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.resetAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('the first-send watch', () => {
  it('stays quiet when the page sends in time (the conditions held): no report, nothing left behind', () => {
    const storage = memoryStorage(), sent = { current: false };
    storage.setItem(markerKey(SESSION), REQUEST);
    watch(storage, sent);
    vi.advanceTimersByTime(800);
    sent.current = true; firstSendDone(storage, SESSION); storage.removeItem(markerKey(SESSION));
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS * 3);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect([...storage.map.keys()]).toEqual([]);
  });

  it('is not armed on a visit without the start page\'s marker (a reload, an opened conversation), or with another request\'s marker', () => {
    const storage = memoryStorage();
    watch(storage, { current: false });
    storage.setItem(markerKey(SESSION), 'another-request');
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS * 3);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('reports once, after the delay, with the four conditions as 0/1 and two durations; never the text or an id', () => {
    const storage = memoryStorage();
    storage.setItem(markerKey(SESSION), REQUEST);
    watch(storage, { current: false }, { state: () => ({ hasInput: true, hasView: false, notBusy: true }) });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS - 1);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledWith(FIRST_SEND_STALLED, { level: 'warning', fingerprint: [FIRST_SEND_STALLED],
      tags: { category: 'runtime', code: FIRST_SEND_STALLED },
      extra: { hasInput: 1, hasView: 0, notBusy: 1, markerMatches: 1, pageAgeMs: 1234, waitedMs: FIRST_SEND_WATCH_MS } });
    // Once per conversation and tab: a later mount does not report again.
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS * 3);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('a page that mounts again after the marker was taken (and so would not send) still reports, on the first page\'s clock', () => {
    const storage = memoryStorage();
    storage.setItem(markerKey(SESSION), REQUEST);
    const cancel = watch(storage, { current: false });
    vi.advanceTimersByTime(5_000);
    storage.removeItem(markerKey(SESSION)); cancel();
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS - 5_000);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage.mock.calls[0]![1].extra).toMatchObject({ markerMatches: 0, waitedMs: FIRST_SEND_WATCH_MS });
  });

  it('coming back before the page sent (the marker still there) starts the clock again instead of reporting at once', () => {
    const storage = memoryStorage();
    storage.setItem(markerKey(SESSION), REQUEST);
    const cancel = watch(storage, { current: false });
    vi.advanceTimersByTime(5_000); cancel();
    vi.advanceTimersByTime(15_000);
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS - 1);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sentry.captureMessage.mock.calls[0]![1].extra).toMatchObject({ markerMatches: 1, waitedMs: FIRST_SEND_WATCH_MS });
  });

  it('a send after a report leaves the report recorded; storage that throws arms nothing', () => {
    const storage = memoryStorage();
    storage.setItem(markerKey(SESSION), REQUEST);
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS);
    firstSendDone(storage, SESSION);
    expect(storage.getItem('opc-runtime-send-watch:' + SESSION)).toBe('reported');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined, removeItem: () => undefined, map: new Map() };
    expect(() => watch(broken as never, { current: false })()).not.toThrow();
  });

  it('a watch left by a page closed long ago is dropped, not reported on the next visit', () => {
    const storage = memoryStorage();
    storage.setItem('opc-runtime-send-watch:' + SESSION, String(Date.now() - FIRST_SEND_WATCH_MS * 5));
    watch(storage, { current: false });
    vi.advanceTimersByTime(FIRST_SEND_WATCH_MS * 3);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it('the Sentry scrubber keeps exactly those six integers for this code and drops anything else', () => {
    const event = { message: FIRST_SEND_STALLED, extra: { hasInput: 1, hasView: 0, notBusy: 1, markerMatches: 1, pageAgeMs: 1234,
      waitedMs: 15000, sessionId: SESSION, text: '你好' } };
    const out = scrubErrorEvent(event as never);
    expect(out.extra).toEqual({ hasInput: 1, hasView: 0, notBusy: 1, markerMatches: 1, pageAgeMs: 1234, waitedMs: 15000 });
    expect(out.fingerprint).toEqual([FIRST_SEND_STALLED]);
  });
});
