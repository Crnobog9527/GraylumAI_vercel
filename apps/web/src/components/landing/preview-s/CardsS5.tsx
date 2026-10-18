/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BATCHES_S5, batchPose, DEPTH_S5, type CardS5 } from './cards-s5';
import styles from './s5.module.css';
import { ZONE_EVENT } from './use-zone-weights';

const TORN = `polygon(${[
  '0 6%, 8% 0, 17% 5%, 26% 1%, 36% 6%, 47% 2%, 58% 6%, 69% 1%, 80% 5%, 90% 0, 100% 5%',
  '100% 95%, 91% 100%, 81% 95%, 70% 99%, 59% 94%, 48% 99%, 37% 95%, 26% 100%, 15% 95%, 6% 100%, 0 94%',
].join(', ')})`;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/** The part of the page each batch rests beside when nothing moves (reduced motion). */
const ANCHORS = ['[data-region="三步"]', '[aria-labelledby="step-one-title"]', '[data-region="评审团"]'];

function Card({ card }: { card: CardS5 }) {
  // Kept on screen at narrower widths: a left card never starts before 8px, a right one never ends past the edge.
  const left = card.x < 0 ? `max(8px, calc(50% + ${card.x}px))` : `min(calc(100% - ${card.w + 8}px), calc(50% + ${card.x}px))`;
  const depth = DEPTH_S5[card.depth];
  const style = { left, top: `${card.y}%`, width: card.w, height: card.h, '--r': `${card.r}deg`, '--paper': card.colour,
    '--depth-scale': depth.scale, '--depth-shadow': depth.shadow, '--travel': depth.travel } as CSSProperties;
  return (
    <div className={styles.card} style={style} data-kind={card.kind} data-depth={card.depth} data-big={card.big || undefined}
      data-edge={card.edge || undefined}>
      {card.kind === 'photo' ? (
        <figure className={styles.photo}>
          <span style={{ backgroundImage: `url(${card.photo})` }} />
          <figcaption>{card.text}</figcaption>
        </figure>
      ) : (
        <div className={styles.paper} style={card.kind === 'scrap' ? { clipPath: TORN } : undefined}>{card.text}</div>
      )}
      <i className={styles.tape} />
    </div>
  );
}

/**
 * S5's scene cards: one batch per part of the page, behind the content (never over a product window or the words).
 * Driven by the reader's place alone (use-zone-weights' event), so scrolling back plays it backwards: a batch floats
 * in from below and settles as its part arrives, stays put while it is read (step one's scroll track included), and is
 * carried up and away as the next one comes. Reduced motion: every batch simply rests beside its part of the page.
 */
export function CardsS5() {
  const batches = useRef<(HTMLDivElement | null)[]>([]);
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (reducedMotion()) { setStill(true); return; }
    const onPlace = (event: Event) => {
      const t = (event as CustomEvent<number>).detail;
      BATCHES_S5.forEach((batch, index) => {
        const node = batches.current[index];
        if (!node) return;
        let shown = false;
        for (const depth of [0, 1, 2] as const) {
          const pose = batchPose(batch, t, depth);
          node.style.setProperty(`--lift-${depth}`, pose.lift.toFixed(4));
          node.style.setProperty(`--turn-${depth}`, `${pose.turn.toFixed(2)}deg`);
          node.style.setProperty(`--fade-${depth}`, pose.fade.toFixed(3));
          shown ||= pose.fade > 0;
        }
        node.style.visibility = shown ? 'visible' : 'hidden';
      });
    };
    window.addEventListener(ZONE_EVENT, onPlace);
    return () => window.removeEventListener(ZONE_EVENT, onPlace);
  }, []);
  useEffect(() => {
    if (!still) return;
    const place = () => BATCHES_S5.forEach((_, index) => {
      const node = batches.current[index];
      const anchor = document.querySelector<HTMLElement>(ANCHORS[index]!);
      if (node && anchor) node.style.top = `${anchor.getBoundingClientRect().top + window.scrollY}px`;
    });
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [still]);
  return (
    <div className={still ? styles.cardsStill : styles.cards}>
      {BATCHES_S5.map((batch, index) => (
        <div key={batch.name} ref={node => { batches.current[index] = node; }} className={styles.batch} data-batch={batch.name}>
          {batch.cards.map(card => <Card key={`${card.kind}-${card.x}-${card.y}`} card={card} />)}
        </div>
      ))}
    </div>
  );
}
