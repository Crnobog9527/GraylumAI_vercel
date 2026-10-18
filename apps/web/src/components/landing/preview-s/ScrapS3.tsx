/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import styles from './s3.module.css';

/** A piece pinned on the board: where (x from the page's centre, y from the top, px), its tilt, and what it is. */
type Piece = { x: number; y: number; r: number; kind: 'photo' | 'note' | 'scrap'; colour?: string; photo?: string; text?: string; w: number; h: number };

/**
 * The first screen's pieces, kept clear of the centred title (the middle 820 px). Notes are in the creator's hand (the
 * only place the handwriting face is used); photos are the Owner's AI-generated stills, marked 示意 (local preview only).
 */
const PIECES: Piece[] = [
  { kind: 'photo', photo: '/landing-s/s-5.webp', text: '下班路上 · 示意', x: -640, y: 150, r: -7, w: 196, h: 232 },
  { kind: 'note', colour: '#ffd84d', text: '每晚 1 小时', x: -590, y: 440, r: 5, w: 168, h: 146 },
  { kind: 'scrap', colour: '#ff6b4a', x: -660, y: 660, r: -4, w: 236, h: 74 },
  { kind: 'photo', photo: '/landing-s/s-7.webp', text: '录一盘家常菜 · 示意', x: 430, y: 140, r: 6, w: 204, h: 240 },
  { kind: 'note', colour: '#8fddb5', text: '收藏率 5.7%', x: 450, y: 450, r: -4, w: 214, h: 118 },
  { kind: 'scrap', colour: '#8ec5ff', x: 420, y: 650, r: 8, w: 160, h: 60 },
];

/** Torn top and bottom edges for a paper piece: small, fixed zigzags (no randomness, so server and client agree). */
const TORN = 'polygon(0 6%, 8% 0, 17% 5%, 26% 1%, 36% 6%, 47% 2%, 58% 6%, 69% 1%, 80% 5%, 90% 0, 100% 5%, 100% 95%, 91% 100%, 81% 95%, 70% 99%, 59% 94%, 48% 99%, 37% 95%, 26% 100%, 15% 95%, 6% 100%, 0 94%)';

/**
 * S3 "创作者的剪贴本": the page is a creator's inspiration board — kraft paper with a little print grain, torn coloured
 * paper, translucent tape, handwritten notes and small instant photos around the title. The one authored moment: the
 * pieces are pressed onto the board one after another (once). Step one's window and the jury are taped to the board,
 * with a photo and a scrap peeking from behind them (s3.module.css), never over their content.
 */
export function ScrapS3() {
  return (
    <div className={styles.scene}>
      {PIECES.map((piece, order) => {
        const style = { left: `calc(50% + ${piece.x}px)`, top: piece.y, width: piece.w, height: piece.h, '--r': `${piece.r}deg`,
          '--i': order, '--paper': piece.colour } as CSSProperties;
        return (
          <div key={`${piece.kind}-${order}`} className={styles.piece} style={style} data-kind={piece.kind}>
            {piece.kind === 'photo' ? (
              <figure className={styles.photo}>
                <span style={{ backgroundImage: `url(${piece.photo})` }} />
                <figcaption>{piece.text}</figcaption>
              </figure>
            ) : (
              <div className={styles.paper} style={piece.kind === 'scrap' ? { clipPath: TORN } : undefined}>{piece.text}</div>
            )}
            <i className={styles.tape} />
          </div>
        );
      })}
    </div>
  );
}
