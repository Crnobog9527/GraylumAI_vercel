/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type TouchEvent } from 'react';
import * as Layer from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { lightDialogStyle, lightPortalClass } from '@/components/design/light-portal';
import { largePicture, type IntegrationPair, type IntegrationSample } from '@/lib/integrations/catalog';
import styles from './integration-viewer.module.css';

/** Which pair is open large, and which of its two pictures was asked for (0: the photo, 1: what came of it). */
export type Viewing = { pair: number; side: 0 | 1 };

/** How far down a finger has to drag the sheet before letting go closes it. */
const DRAG_TO_CLOSE = 90;

/**
 * A photo and what came of it, large (Owner 2026-11-13: "这些图片，要支持用户点击以后看大图"). A layer over the introduction:
 * on a computer the two pictures side by side; on a phone a sheet with one picture across the screen, changed by a swipe
 * sideways or by the two buttons above it. The arrows (and the arrow keys) go to the pair before and after. It closes by its
 * button, a press outside, Esc, or on a phone by dragging it down; focus then goes back to the picture that opened it.
 * The large files are asked for only here; until one arrives its box holds the small picture, already at hand, the same size.
 */
export function IntegrationViewer({ pairs, at, onMove, onClose, opener }: {
  pairs: readonly IntegrationPair[]; at: Viewing; onMove: (to: Viewing) => void; onClose: () => void;
  /** The picture that was pressed: where focus goes when this closes (the layer has no trigger of its own to return to). */
  opener?: HTMLElement | null;
}) {
  const pair = pairs[at.pair];
  const drag = useRef<{ x: number; y: number; down: number } | null>(null);
  const [pulled, setPulled] = useState(0);
  if (!pair) return null;
  const go = (step: -1 | 1) => { if (pairs[at.pair + step]) onMove({ pair: at.pair + step, side: 0 }); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
  };
  // Dragging the sheet down with a finger follows the finger; let go far enough and it closes, otherwise it springs back.
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    drag.current = touch ? { x: touch.clientX, y: touch.clientY, down: 0 } : null;
  };
  const touchMove = (event: TouchEvent) => {
    const [from, touch] = [drag.current, event.touches[0]];
    if (!from || !touch) return;
    const [down, across] = [touch.clientY - from.y, Math.abs(touch.clientX - from.x)];
    from.down = down > 12 && down > across * 1.5 ? down : 0;
    setPulled(from.down);
  };
  const touchEnd = () => {
    const down = drag.current?.down ?? 0;
    drag.current = null;
    if (down > DRAG_TO_CLOSE) onClose(); else setPulled(0);
  };
  return (
    <Layer.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Layer.Portal>
        <Layer.Overlay className={styles.overlay}/>
        <Layer.Content className={`${lightPortalClass} ${styles.panel}`} data-pulled={pulled > 0}
          style={{ ...lightDialogStyle, '--pulled': `${pulled}px` } as CSSProperties}
          onCloseAutoFocus={event => { event.preventDefault(); opener?.focus(); }}
          onKeyDown={keys} onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={touchEnd} onTouchCancel={touchEnd}>
          <header className={styles.head}>
            {/* Said again when the arrows change the pair. */}
            <div aria-live="polite">
              <Layer.Title className={styles.title}>{pair.title}</Layer.Title>
              <Layer.Description className={styles.note}>{pair.note}</Layer.Description>
            </div>
            <Layer.Close className={styles.close}><X aria-hidden="true"/><span className="sr-only">关闭</span></Layer.Close>
          </header>
          <Sides pair={pair} at={at} onMove={onMove}/>
          <nav className={styles.steps} aria-label="换一组图">
            <button type="button" disabled={!pairs[at.pair - 1]} onClick={() => go(-1)}>
              <ChevronLeft aria-hidden="true"/><span className="sr-only">上一组</span></button>
            <span>{at.pair + 1} / {pairs.length}</span>
            <button type="button" disabled={!pairs[at.pair + 1]} onClick={() => go(1)}>
              <ChevronRight aria-hidden="true"/><span className="sr-only">下一组</span></button>
          </nav>
        </Layer.Content>
      </Layer.Portal>
    </Layer.Root>
  );
}

/**
 * The pair's two pictures. On a computer they stand side by side. On a phone they are a strip that scrolls sideways, one
 * across the screen at a time, with the two names above it as the way from one to the other without a swipe.
 * (Its own component: the layer's content is mounted a moment after the layer, and the strip has to be there to be scrolled.)
 */
function Sides({ pair, at, onMove }: { pair: IntegrationPair; at: Viewing; onMove: (to: Viewing) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bring the picture asked for across the screen (nothing to do where the two already show side by side).
  useEffect(() => {
    const row = strip.current;
    if (row && row.scrollWidth > row.clientWidth + 1) row.scrollLeft = at.side * row.clientWidth;
  }, [at.pair, at.side]);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  /** After a swipe has come to rest: the picture now across the screen is the one the two names mark. */
  const swiped = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const row = strip.current;
      if (!row || row.scrollWidth <= row.clientWidth + 1) return;
      const side = Math.round(row.scrollLeft / row.clientWidth) ? 1 : 0;
      if (side !== at.side) onMove({ pair: at.pair, side });
    }, 120);
  };
  return <>
    <div className={styles.sides} role="group" aria-label="看哪一张">
      {pair.sides.map((side, index) => (
        <button key={side.src} type="button" aria-pressed={at.side === index}
          onClick={() => onMove({ pair: at.pair, side: index ? 1 : 0 })}>{side.label}</button>
      ))}
    </div>
    <div className={styles.strip} ref={strip} onScroll={swiped}>
      {pair.sides.map(side => <Large key={side.src} side={side} cutout={pair.cutout && side === pair.sides[1]}/>)}
    </div>
  </>;
}

/**
 * One picture, large, named under it. Until the large file has arrived and can be painted (decoded: a file that has only been
 * fetched still shows nothing for a moment), the box shows the small one, so nothing moves and nothing blinks.
 */
function Large({ side, cutout }: { side: IntegrationSample; cutout: boolean }) {
  const [arrived, setArrived] = useState(false);
  const ready = (image: HTMLImageElement) => { void image.decode().catch(() => undefined).then(() => setArrived(true)); };
  return (
    <figure className={styles.side}>
      <img src={largePicture(side.src)} alt={side.alt} width={960} height={1200} data-arrived={arrived}
        data-cutout={cutout ? 'true' : undefined} style={{ '--small': `url(${side.src})` } as CSSProperties}
        onLoad={event => ready(event.currentTarget)}/>
      <figcaption>{side.label}</figcaption>
    </figure>
  );
}
