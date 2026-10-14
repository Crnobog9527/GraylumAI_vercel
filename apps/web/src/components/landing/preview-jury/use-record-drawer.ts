/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeatCode } from './jury-events';

/** How long the record stays out after the pointer leaves a badge or note, so it can travel into the drawer. */
const LINGER_MS = 280;

/**
 * Who the record drawer shows, and whether it is out. Pointing at a person or a note peeks; leaving lets it slide back
 * after a short linger that the drawer itself cancels while the pointer (or focus) is inside it. A click pins it open
 * until closed, Escape, or a second click on the same person.
 */
export function useRecordDrawer() {
  const [peek, setPeekNow] = useState<SeatCode | null>(null);
  const [pinned, setPinned] = useState<SeatCode | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const hold = useCallback(() => window.clearTimeout(timer.current), []);
  const setPeek = useCallback((seat: SeatCode | null) => {
    window.clearTimeout(timer.current);
    if (seat) setPeekNow(seat);
    else timer.current = window.setTimeout(() => setPeekNow(null), LINGER_MS);
  }, []);
  const pin = useCallback((seat: SeatCode) => {
    window.clearTimeout(timer.current);
    setPinned(seat);
    setPeekNow(null);
  }, []);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setPinned(null);
    setPeekNow(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pinned && !peek) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, peek, close]);

  return { peek, pinned, setPeek, pin, close, hold };
}
