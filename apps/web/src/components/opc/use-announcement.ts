'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useSyncExternalStore } from 'react';
import { ANNOUNCEMENT, ANNOUNCEMENT_CLOSED_KEY, ANNOUNCEMENT_CLOSED_MARK } from '@/lib/announcement';

const listeners = new Set<() => void>();
// Closed in this page's memory too, so the bar goes even where the browser keeps nothing (private windows, storage turned off).
let closedHere = false;

function subscribe(changed: () => void) {
  listeners.add(changed);
  window.addEventListener('storage', changed);
  return () => { listeners.delete(changed); window.removeEventListener('storage', changed); };
}
function closedNow() {
  if (closedHere) return true;
  try { return window.localStorage.getItem(ANNOUNCEMENT_CLOSED_KEY) === ANNOUNCEMENT.id; } catch { return false; }
}

/**
 * Whether the announcement shows, and the way to close it (Owner 2026-11-12: closable, and it stays closed). Closing is
 * remembered in the browser by the announcement's id, so it stays closed across pages, reloads and tabs, and a new
 * announcement shows again. The server always draws the bar; the mark on <html> (set before the first paint by
 * ANNOUNCEMENT_FIRST_PAINT_SCRIPT, and here on closing) keeps a closed one from showing in the meantime.
 */
export function useAnnouncementOpen(): [open: boolean, close: () => void] {
  const closed = useSyncExternalStore(subscribe, closedNow, () => false);
  const close = useCallback(() => {
    closedHere = true;
    try { window.localStorage.setItem(ANNOUNCEMENT_CLOSED_KEY, ANNOUNCEMENT.id); } catch { /* Remembered for this page only. */ }
    document.documentElement.setAttribute(ANNOUNCEMENT_CLOSED_MARK, '');
    listeners.forEach(changed => changed());
  }, []);
  return [!closed, close];
}
