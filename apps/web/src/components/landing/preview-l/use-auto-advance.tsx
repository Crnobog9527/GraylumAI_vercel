/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useOwnerEditing } from '@/components/landing/preview-j/use-owner-editing';
import demo from './demo-l.module.css';

/** Once fully written, a demo stays at least this long (milliseconds). */
export const READ_MS = 8000;
/** The pointer must have been out of the demo this long. */
export const OUT_MS = 1000;
/** The thin bar on the next tab fills this long before the move. */
export const COUNTDOWN_MS = 3000;

/**
 * When a tabbed demo moves on to its next part by itself (round eight, U9 and U11, Owner 2026-10-18), shared by steps
 * two and three and region 6: the typing never stops, but it moves on only when the current part is fully written
 * (`written`) and has stayed READ_MS since, and the pointer has been out of the demo (`hand`, spread on the demo's
 * frame) for OUT_MS; a finger touching or scrolling in it holds it READ_MS. Then a bar on the next tab fills for
 * COUNTDOWN_MS (`countdown`, 0 → 1) and `next` runs; the pointer coming back empties the bar. `part` names the part on
 * screen: a new one, picked by the visitor or reached, starts its own count once written. While the Owner's local edit
 * mode is on, nothing moves on (Owner 2026-10-18).
 */
export function useAutoAdvance({ on, written, hasNext, next, part }: {
  on: boolean; written: boolean; hasNext: boolean; next: () => void; part: unknown;
}) {
  const pointerIn = useRef(false);
  const leftAt = useRef(0);
  const touchedAt = useRef(0);
  const doneAt = useRef(0);
  const from = useRef(0);
  const nextRef = useRef(next);
  nextRef.current = next;
  const [countdown, setCountdown] = useState(0);
  const editing = useOwnerEditing();
  const clear = () => { from.current = 0; setCountdown(0); };

  useEffect(() => { doneAt.current = written ? Date.now() : 0; clear(); }, [written, part]);
  useEffect(() => {
    if (!on || editing || !written || !hasNext) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const ready = doneAt.current > 0 && now - doneAt.current >= READ_MS && !pointerIn.current
        && now - leftAt.current >= OUT_MS && now - touchedAt.current >= READ_MS;
      if (!ready) { if (from.current) clear(); return; }
      if (!from.current) from.current = now;
      const share = Math.min(1, (now - from.current) / COUNTDOWN_MS);
      setCountdown(share);
      if (share >= 1) { clear(); nextRef.current(); }
    }, 100);
    return () => window.clearInterval(timer);
  }, [on, editing, written, hasNext, part]);

  const hand = {
    onPointerEnter: () => { pointerIn.current = true; clear(); },
    onPointerLeave: () => { pointerIn.current = false; leftAt.current = Date.now(); },
    onTouchStart: () => { touchedAt.current = Date.now(); clear(); },
    onTouchMove: () => { touchedAt.current = Date.now(); },
  };
  return { countdown, hand };
}

/** The bar inside the next tab while the move is coming (the tab gets `countdownHost`). */
export function CountdownBar({ share }: { share: number }) {
  return share > 0 ? <i className={demo.countdown} style={{ transform: `scaleX(${share})` }} aria-hidden="true" /> : null;
}
export const countdownHost = demo.countdownHost;
