/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BookOpen, Check, FileCheck2, FileX2, Gavel, MessageSquareReply, PenLine, Scale, TriangleAlert } from 'lucide-react';
import {
  DECISIONS, DECISION_LABEL, SEATS, STANCE_LABEL, VERDICT_LABEL, type JurySeatNames, type Seat, type SeatCode,
} from './jury-events';
import { statusWord, type CanvasCard, type CanvasView, type Edge, type Node } from './jury-canvas';
import { MOCK_REPORT, type JuryCaseReport } from './jury-case';
import { RulingSeal, SeatMark } from './JuryBits';
import styles from './jury-canvas.module.css';

type Box = { cx: number; cy: number; top: number; bottom: number; left: number; right: number };
type Boxes = Partial<Record<Node | `end-${SeatCode}`, Box>>;
/** Without onPick the people and cards are plain text, not buttons that do nothing. */
type Hover = { onPeek: (seat: SeatCode | null) => void; onPick?: (seat: SeatCode) => void };


/**
 * The review as a canvas: the user's report on top, the three reviewers hung under it on threads, the summary under
 * them (threaded to their results only once it starts writing) and the revised report under the summary. Each
 * person's work grows downward as a short string of cards. Only the thing happening now is lit; pointing at (or tapping) a person or a card opens their full
 * record.
 */
export function JuryCanvas({ view, names, selected, onPeek, onPick, report = MOCK_REPORT, follow = true, captionAbove = false }: {
  view: CanvasView; names: JurySeatNames; selected: SeatCode | null;
  /** The two reports shown; the prototype's mock creator by default. */
  report?: JuryCaseReport;
  /** On a phone, scroll the page to keep what happens now in view. Off when the page's own scrolling drives the
   * canvas; on a computer the canvas always scrolls inside itself. */
  follow?: boolean;
  /** Put the sentence about now in a bar above the canvas instead of floating over it, so it never covers a report
   * card's title (the short version embedded on the landing page). */
  captionAbove?: boolean;
} & Hover) {
  const scroller = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const boxes = useNodeBoxes(board, `${view.caption}|${view.next.state}|${SEATS.map(seat => view.columns[seat].length).join()}`);
  useFollowCurrent(scroller, view.current, view.focus.join(), follow);
  const lane = { view, names, selected, onPeek, onPick };

  const caption = (
    <p className={captionAbove ? styles.captionBar : styles.caption} aria-live="polite" key={view.caption}>{view.caption}</p>
  );
  const canvas = (
    <div className={styles.scroller} ref={scroller}>
      <div className={styles.board} ref={board}>
        {captionAbove ? null : caption}
        <Wires boxes={boxes} edges={view.edges} joined={view.joined} />
        <article className={styles.doc} data-node="doc" data-state={view.doc.state}>
          <h2>{report.title}</h2>
          <p className={styles.excerpt}>{report.excerpt}</p>
          <footer>
            <span>{report.chapters} 章</span>
            {view.doc.state === 'reading' ? <span className={styles.docReading}>正在被阅读</span> : null}
          </footer>
        </article>
        <div className={styles.lanes}>
          {SEATS.map(seat => <Lane key={seat} seat={seat} {...lane} />)}
        </div>
        <div className={styles.sink}>
          <Lane seat="S" {...lane} />
        </div>
        {view.next.state === 'revised' ? (
          <article className={styles.doc} data-node="next" data-state="revised" data-current={view.current === 'next'}>
            <h2>修订后的{report.title}</h2>
            <p className={styles.excerpt}>{report.revisedExcerpt}</p>
            <footer>
              <span>{report.chapters} 章</span>
              <span className={styles.docStamp}><FileCheck2 size={14} aria-hidden="true" />修订稿改了 {view.next.changed} 章</span>
            </footer>
          </article>
        ) : view.next.state === 'unchanged' ? (
          <p className={styles.unchanged} data-current={view.current === 'next'}><FileX2 size={15} aria-hidden="true" />原文没有任何改动</p>
        ) : null}
      </div>
    </div>
  );
  return captionAbove ? <div className={styles.framed}>{caption}{canvas}</div> : canvas;
}

/** One person: their mark with a status word, and their work hanging under it. The summary waits faintly until it writes. */
function Lane({ seat, view, names, selected, onPeek, onPick }: {
  seat: SeatCode; view: CanvasView; names: JurySeatNames; selected: SeatCode | null;
} & Hover) {
  const dim = view.focus.length > 0 && !view.focus.includes(seat);
  // Once the summary takes over, each reviewer folds to its result card, the one threaded to the summary.
  // At the revision the summary folds too, so the report and the revision fit on one screen.
  const folded = seat === 'S' ? view.stage === 'revision' : view.stage === 'ruling' || view.stage === 'revision';
  return (
    <section className={styles.lane} data-seat={seat} data-dim={dim} data-folded={folded} data-selected={selected === seat} data-node-end={seat}
      data-waiting={seat === 'S' && view.columns.S.length === 0} aria-label={names[seat]}>
      <Press className={styles.head} data-node={seat} title={`${names[seat]}：看完整记录`} seat={seat} onPeek={onPeek} onPick={onPick}>
        <SeatMark seat={seat} names={names} size="lg" />
        <span className={styles.who}>{names[seat]}</span>
        <span className={styles.status}>{statusWord(view, seat)}</span>
      </Press>
      <ol className={styles.cards}>
        {view.columns[seat].map((card, index, list) => {
          const current = view.current === card.key && !dim;
          // Older cards fold to one line, so a column never shows more than one card's worth of words.
          const compact = !current && index < list.length - 1;
          return (
            <li key={card.key} data-current={current}>
              <Press className={styles.card} data-kind={card.kind}
                seat={seat} onPeek={onPeek} onPick={onPick}>
                <CardBody card={card} names={names} compact={compact} />
              </Press>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A person or card: a button that opens the record when the canvas has onPick, otherwise plain content. */
function Press({ seat, onPeek, onPick, title, children, ...rest }: {
  seat: SeatCode; onPeek: Hover['onPeek']; onPick?: Hover['onPick']; title?: string; children: ReactNode;
  className: string; 'data-node'?: string; 'data-kind'?: string;
}) {
  if (!onPick) return <div {...rest}>{children}</div>;
  return (
    <button type="button" {...rest} title={title}
      onMouseEnter={() => onPeek(seat)} onMouseLeave={() => onPeek(null)} onClick={() => onPick(seat)}>
      {children}
    </button>
  );
}

function CardBody({ card, names, compact }: { card: CanvasCard; names: JurySeatNames; compact: boolean }) {
  switch (card.kind) {
    case 'read':
      return card.state === 'reading' ? (
        <><Line icon={<BookOpen size={15} />} text={card.round === 1 ? '在读报告' : '第 2 轮：在读对方理由'} /><span className={styles.pulse} /></>
      ) : card.state === 'done' ? <Line icon={<Check size={15} />} text={card.round === 1 ? '已交卷' : '第 2 轮已交卷'} />
        : <Line icon={<TriangleAlert size={15} />} text="没有给出可用意见" muted />;
    case 'decisions': {
      const changes = card.marks.filter(item => item.verdict === 'change').length;
      if (compact) return <Line icon={<Scale size={15} />} text={`4 个关键决定：${changes > 0 ? `${changes} 项要改` : '都保留'}`} />;
      return (
        <>
          <Line icon={<Scale size={15} />} text="4 个关键决定" />
          <span className={styles.chips}>
            {DECISIONS.map(key => {
              const mark = card.marks.find(item => item.decision === key);
              return (
                <span key={key} className={styles.chip} data-verdict={mark?.verdict ?? 'none'} data-current={card.current === key}>
                  {DECISION_LABEL[key]}{mark ? <b>{VERDICT_LABEL[mark.verdict]}</b> : null}
                </span>
              );
            })}
          </span>
        </>
      );
    }
    case 'issues':
      return (
        <>
          <Line icon={<PenLine size={15} />} text={`批注 ${card.shown} 条`} />
          <span className={styles.dots} aria-hidden="true">
            {Array.from({ length: card.total }, (_, index) => (
              <i key={index} data-severity={card.severities[index] ?? 'none'} />
            ))}
          </span>
          {card.line ? <span className={styles.quote}><em>{card.where}</em>{card.line}</span> : null}
        </>
      );
    case 'stances':
      if (compact) {
        return <Line icon={<Scale size={15} />} text={`有分歧的决定 ${card.items.length} 项`} accent={card.items.some(item => item.turned)} />;
      }
      return (
        <>
          <Line icon={<Scale size={15} />} text="有分歧的决定" accent={card.items.some(item => item.turned)} />
          <span className={styles.chips}>
            {card.items.map(item => (
              <span key={item.decision} className={styles.chip} data-verdict={item.verdict} data-current={card.current === item.decision}>
                {DECISION_LABEL[item.decision]}<b>{item.turned ? `改判${VERDICT_LABEL[item.verdict]}` : VERDICT_LABEL[item.verdict]}</b>
              </span>
            ))}
          </span>
        </>
      );
    case 'replies':
      return (
        <>
          <Line icon={<MessageSquareReply size={15} />} text={`第 2 轮回应 ${card.count} 条`} />
          {card.latest ? (
            <span className={styles.quote}>
              {`回应${names[card.latest.to]}：${DECISION_LABEL[card.latest.decision]}`}
              {card.latest.stance ? <b className={styles.stance}>{STANCE_LABEL[card.latest.stance]}</b> : null}
            </span>
          ) : null}
        </>
      );
    case 'writing':
      return card.done ? <Line icon={<Check size={15} />} text="读完全部意见" />
        : <><Line icon={<PenLine size={15} />} text="汇总中" /><span className={styles.pulse} /></>;
    case 'rulings':
      return (
        <>
          <Line icon={<Gavel size={15} />} text={`裁决 ${card.shown}/${card.total}，采纳 ${card.adopted} 条`} />
          {card.line ? (
            <span className={styles.quote}>{card.line}{card.sealed === null ? null : <RulingSeal adopted={card.sealed} />}</span>
          ) : null}
        </>
      );
    case 'result':
      return (
        <Line icon={<FileCheck2 size={15} />}
          text={`结果：${card.issues} 条批注，${card.changes > 0 ? `${card.changes} 个决定要改` : '决定都保留'}`} />
      );
    case 'revision':
      return card.changed === null ? <Line icon={<FileX2 size={15} />} text="修订稿未通过检查" muted />
        : <Line icon={<FileCheck2 size={15} />} text={`修订稿：改了 ${card.changed} 章`} accent />;
  }
}

function Line({ icon, text, muted, accent }: { icon: ReactNode; text: string; muted?: boolean; accent?: boolean }) {
  return (
    <span className={styles.line} data-muted={muted} data-accent={accent}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>{text}
    </span>
  );
}

/** Where each node sits on the board (the reports, the marks, the bottom of each column), re-measured as cards arrive. */
function useNodeBoxes(board: RefObject<HTMLDivElement | null>, layout: string) {
  const [boxes, setBoxes] = useState<Boxes>({});
  const measure = useCallback(() => {
    const root = board.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const box = (rect: DOMRect): Box => ({
      cx: rect.left - origin.left + rect.width / 2, cy: rect.top - origin.top + rect.height / 2,
      top: rect.top - origin.top, bottom: rect.bottom - origin.top, left: rect.left - origin.left, right: rect.right - origin.left,
    });
    const next: Boxes = {};
    root.querySelectorAll<HTMLElement>('[data-node]').forEach(element => { next[element.dataset.node as Node] = box(element.getBoundingClientRect()); });
    root.querySelectorAll<HTMLElement>('[data-node-end]').forEach(element => {
      next[`end-${element.dataset.nodeEnd as SeatCode}`] = box(element.getBoundingClientRect());
    });
    setBoxes(next);
  }, [board]);
  useLayoutEffect(measure, [measure, layout]);
  useLayoutEffect(() => {
    const root = board.current;
    if (!root) return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [board, measure]);
  return boxes;
}

/** Keep the card the stage is about in view inside the canvas (only when the canvas scrolls by itself). */
function useFollowCurrent(scroller: RefObject<HTMLDivElement | null>, current: string | null, focus: string, enabled: boolean) {
  useEffect(() => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>('[data-current="true"]');
    if (!root || !target) return;
    if (getComputedStyle(root).overflowY === 'visible') {
      if (!enabled) return;
      // On a phone the page itself scrolls. Follow only while the canvas is on screen, so a reader who scrolled
      // away to the records below is left alone.
      const rect = root.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (root.scrollHeight <= root.clientHeight + 1) return;
    const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const bottom = top + target.offsetHeight;
    if (top < root.scrollTop + 60 || bottom > root.scrollTop + root.clientHeight - 24) {
      root.scrollTo({ top: Math.max(0, bottom - root.clientHeight + 48), behavior: 'smooth' });
    }
  }, [scroller, current, focus, enabled]);
}

function threadPath(from: Box, to: Box, spread: number): string {
  const sx = from.cx + spread;
  const sy = from.bottom;
  const ey = to.top;
  const mid = (ey - sy) / 2;
  return `M ${sx} ${sy} C ${sx} ${sy + mid}, ${to.cx} ${ey - mid}, ${to.cx} ${ey}`;
}

function arcPath(from: Box, to: Box): string {
  const lift = Math.min(70, Math.abs(to.cx - from.cx) * 0.22 + 18);
  const y = Math.min(from.top, to.top);
  return `M ${from.cx} ${from.top} C ${from.cx} ${y - lift}, ${to.cx} ${y - lift}, ${to.cx} ${to.top}`;
}

/**
 * The threads: the report to each reviewer always (faint); each reviewer's result to the summary only once it starts
 * writing; the summary to the new report it writes; then whatever is lit now.
 */
function Wires({ boxes, edges, joined }: { boxes: Boxes; edges: readonly Edge[]; joined: readonly Seat[] }) {
  const { doc, S: summary } = boxes;
  if (!doc || !summary || SEATS.some(seat => !boxes[seat] || !boxes[`end-${seat}`])) {
    return <svg className={styles.wires} aria-hidden="true" />;
  }
  const spread = (seat: Seat) => (SEATS.indexOf(seat) - 1) * 28;
  const join = (seat: Seat) => threadPath(boxes[`end-${seat}`] as Box, summary, 0);
  const path = (edge: Edge) => {
    if (edge.to === 'next') return boxes.next && boxes['end-S'] ? threadPath(boxes['end-S'], boxes.next, 0) : '';
    if (edge.from === 'doc') return threadPath(doc, boxes[edge.to] as Box, spread(edge.to as Seat));
    if (edge.to === 'S') return join(edge.from as Seat);
    const from = boxes[edge.from];
    const to = boxes[edge.to];
    return from && to ? arcPath(from, to) : '';
  };
  return (
    <svg className={styles.wires} aria-hidden="true">
      {SEATS.map(seat => <path key={seat} d={threadPath(doc, boxes[seat] as Box, spread(seat))} className={styles.thread} />)}
      {joined.map(seat => <path key={`join-${seat}`} d={join(seat)} className={styles.thread} />)}
      {edges.map(edge => (
        <path key={`${edge.from}-${edge.to}`} d={path(edge)} className={styles.lit} data-tone={edge.tone} />
      ))}
    </svg>
  );
}
