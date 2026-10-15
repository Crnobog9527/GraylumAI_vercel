/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type KeyboardEvent } from 'react';
import { ChevronUp } from 'lucide-react';
import type { JuryDetail, JurySeatNames, SeatCode } from './jury-events';
import { JuryDossier, type Arrived } from './JuryDossier';
import styles from './jury-layout.module.css';

/**
 * Each person's work record, always at hand: a column on the right with a tab per person on a computer, a panel to
 * pull up from the bottom on a phone. It follows whoever the canvas is about until the user picks a tab or starts
 * scrolling a record (following would swap the record under them); 跟随当前 picks it up again.
 */
export function JuryRecords({ detail, names, arrived, live, following, picked, onPick, onFollow }: {
  detail: JuryDetail; names: JurySeatNames; arrived: Arrived; live: boolean;
  following: SeatCode; picked: SeatCode | null; onPick: (seat: SeatCode) => void; onFollow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const seat = picked ?? following;
  const hold = () => { if (live && !picked) onPick(seat); };
  const holdOnKey = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) hold(); };
  return (
    <aside className={styles.records} data-open={open} aria-label="评审工作记录">
      <button type="button" className={styles.recordsHandle} onClick={() => setOpen(value => !value)} aria-expanded={open}>
        工作记录：{names[seat]}<ChevronUp size={16} aria-hidden="true" />
      </button>
      <div className={styles.recordsHead}>
        <span>工作记录</span>
        {picked && live ? <button type="button" onClick={onFollow}>跟随当前</button> : null}
      </div>
      <div className={styles.recordsBody} onWheel={hold} onTouchMove={hold} onPointerDown={hold} onKeyDown={holdOnKey}>
        <JuryDossier detail={detail} names={names} seat={seat} arrived={arrived} live={live} onSelect={onPick} />
      </div>
    </aside>
  );
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
