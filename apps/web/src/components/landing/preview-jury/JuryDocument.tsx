/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { JurySeatNames, SeatCode } from './jury-events';
import type { DeskView } from './jury-desk';
import { diffText } from './jury-diff';
import { REVISION_TEXT } from './jury-mock-rulings';
import { REPORT_CHAPTERS, REPORT_TITLE, WHOLE_DOCUMENT } from './jury-report';
import { SeatMark } from './JuryBits';
import { JuryMargin, type PeekHandlers } from './JuryMargin';
import styles from './jury-document.module.css';

const CURSOR_SEATS: readonly SeatCode[] = ['A', 'B', 'C', 'S'];

function Redline({ title }: { title: string }) {
  const text = REVISION_TEXT[title];
  if (!text) return null;
  return (
    <p className={styles.body}>
      {diffText(text.original, text.revised).map((part, index) => part.type === 'same'
        ? <span key={index}>{part.text}</span>
        : part.type === 'del'
          ? <del key={index} className={styles.del}>{part.text}</del>
          : <ins key={index} className={styles.ins}>{part.text}</ins>)}
    </p>
  );
}

/**
 * The user's report as a page, chapter by chapter, with each chapter's notes in the margin beside it (below it on a
 * phone). While reviewers read, their marks move down the page and the chapter under them is tinted; the stage
 * scrolls the page to whatever chapter it is about. `still` lays the whole page out with no scrolling box.
 */
export function JuryDocument({ view, names, still, ...handlers }: PeekHandlers & { view: DeskView; names: JurySeatNames; still?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState<Record<string, number>>({});
  const wrap = useRef<HTMLDivElement>(null);

  // Cursor positions follow the rows, which grow as notes arrive: measure whenever the column changes size.
  useLayoutEffect(() => {
    const node = wrap.current;
    if (still || !node) return;
    const measure = () => setTops(previous => {
      const next = Object.fromEntries([...rows.current].map(([title, row]) => [title, row.offsetTop]));
      const same = Object.keys(next).length === Object.keys(previous).length && Object.entries(next).every(([key, top]) => previous[key] === top);
      return same ? previous : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [still]);

  useEffect(() => {
    const box = scroller.current;
    const target = view.focus ? rows.current.get(view.focus) : null;
    if (still || !box || !target) return;
    const top = box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - 24;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [still, view.focus]);

  const chapters = [...REPORT_CHAPTERS, ...(view.notes[WHOLE_DOCUMENT] ? [{ title: WHOLE_DOCUMENT, number: '', name: '全文意见', body: '' }] : [])];
  return (
    <div className={cn(styles.viewport, still && styles.still)} ref={scroller} tabIndex={still ? undefined : 0} aria-label="被审阅的报告">
      <div className={styles.page} data-mode={view.mode}>
        <div className={styles.rowsWrap} ref={wrap}>
          <div className={styles.headRow}>
            <header className={styles.docHead}>
              <h2>{REPORT_TITLE}</h2>
              <p>{REPORT_CHAPTERS.length} 章，评审期间这份报告保持冻结，不会被改动</p>
            </header>
            {view.revisionFailed ? <p className={styles.banner} role="status">修订稿没有通过检查，报告原文没有任何改动；评审意见保留在页边供你参考。</p> : null}
          </div>
          {still ? null : (
            <div className={styles.cursors} aria-hidden="true">
              {CURSOR_SEATS.map(seat => {
                const at = view.reading[seat];
                return (
                  <span key={seat} className={styles.cursor} data-on={Boolean(at)} style={{ transform: `translateY(${at ? tops[at] ?? 0 : 0}px)` }}>
                    <SeatMark seat={seat} names={names} size="sm" />
                  </span>
                );
              })}
            </div>
          )}
          {chapters.map(chapter => {
            const items = view.notes[chapter.title] ?? [];
            const readers = CURSOR_SEATS.filter(seat => view.reading[seat] === chapter.title);
            const marked = view.redline.includes(chapter.title);
            return (
              <section key={chapter.title} className={styles.row} data-focus={view.focus === chapter.title} data-has-notes={items.length > 0}
                data-reader={readers[0]} ref={node => { if (node) rows.current.set(chapter.title, node); else rows.current.delete(chapter.title); }}
                aria-label={chapter.title}>
                <div className={styles.text}>
                  <h3><span className={styles.num}>{chapter.number}</span>{chapter.name}</h3>
                  {marked ? <Redline title={chapter.title} /> : chapter.body ? <p className={styles.body}>{chapter.body}</p> : null}
                  {marked ? <p className={styles.revNote}>修订稿改动了这一章</p> : null}
                </div>
                <div className={styles.gutter}>{items.length > 0 ? <JuryMargin items={items} names={names} {...handlers} /> : null}</div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
