/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SeatCode } from './jury-events';
import type { JudgePose, ReviewerPose } from './jury-poses';
import styles from './jury-room.module.css';

/**
 * Hand-drawn seated figures for the jury room (no external images). Each seat has its own look; the pose is a data
 * attribute that jury-room.module.css animates (arms rotate about the shoulder, the head nods or bows).
 */
type Look = { skin: string; coat: string; sleeve: string; hair: string; hairPath: string; extra?: 'glasses' | 'cap' | 'bun' | 'robe' };

export const LOOKS: Record<SeatCode, Look> = {
  A: {
    skin: '#efcfae', coat: '#2f7d74', sleeve: '#286a62', hair: '#2b2622', extra: 'glasses',
    hairPath: 'M38 44 C36 22 50 14 62 15 C76 16 85 26 82 46 C80 36 74 30 64 30 C54 30 44 34 38 44 Z',
  },
  B: {
    skin: '#c99872', coat: '#4b5fc9', sleeve: '#4051ad', hair: '#3a2a20', extra: 'cap',
    hairPath: 'M40 46 C38 34 42 26 50 24 L74 24 C80 28 82 36 80 48 C78 40 72 36 60 36 C50 36 44 40 40 46 Z',
  },
  C: {
    skin: '#f3d9c4', coat: '#b5527a', sleeve: '#9c4568', hair: '#6b3d22', extra: 'bun',
    hairPath: 'M38 48 C34 26 46 16 60 16 C76 16 86 28 82 50 C80 40 76 34 70 32 C60 36 48 38 38 48 Z',
  },
  S: {
    skin: '#e0b48c', coat: '#2c2c2c', sleeve: '#222', hair: '#8e8a84', extra: 'robe',
    hairPath: 'M39 42 C38 24 50 16 61 16 C74 16 84 24 81 42 C78 34 70 28 60 29 C50 30 42 34 39 42 Z',
  },
};

function Extra({ look }: { look: Look }) {
  switch (look.extra) {
    case 'glasses':
      return (
        <g className={styles.glasses} fill="none" stroke="#1d1d1d" strokeWidth="1.6">
          <rect x="47" y="40" width="11" height="8" rx="3" /><rect x="62" y="40" width="11" height="8" rx="3" /><path d="M58 43 h4" />
        </g>
      );
    case 'cap':
      return <path d="M40 30 C44 16 76 16 80 30 L88 32 C86 35 80 34 78 34 L42 34 Z" fill="#f2b631" />;
    case 'bun':
      return <circle cx="60" cy="13" r="8" fill={look.hair} />;
    case 'robe':
      return <path d="M46 80 L60 100 L74 80 L70 78 L60 92 L50 78 Z" fill="#ffc93c" />;
    default:
      return null;
  }
}

export function JuryCharacter({ seat, pose }: { seat: SeatCode; pose: ReviewerPose | JudgePose }) {
  const look = LOOKS[seat];
  return (
    <svg className={styles.figure} viewBox="0 0 120 140" data-pose={pose} aria-hidden="true" focusable="false">
      <g className={styles.body}>
        <path d="M26 140 C26 100 36 80 60 78 C84 80 94 100 94 140 Z" fill={look.coat} />
        <rect x="54" y="60" width="12" height="20" rx="5" fill={look.skin} />
        <Extra look={seat === 'S' ? look : { ...look, extra: undefined }} />
        <g className={styles.armLeft}>
          <path d="M36 88 C30 102 30 114 36 124" fill="none" stroke={look.sleeve} strokeWidth="10" strokeLinecap="round" />
          <circle cx="37" cy="125" r="5.5" fill={look.skin} />
        </g>
        <g className={styles.armRight}>
          <path d="M84 88 C90 102 90 114 84 124" fill="none" stroke={look.sleeve} strokeWidth="10" strokeLinecap="round" />
          <circle cx="83" cy="125" r="5.5" fill={look.skin} />
          {seat === 'S' ? (
            <g className={styles.gavel}>
              <rect x="80" y="104" width="4" height="26" rx="2" fill="#7a4b22" transform="rotate(-20 82 118)" />
              <rect x="70" y="98" width="22" height="10" rx="3" fill="#8f5a2a" transform="rotate(-20 81 103)" />
            </g>
          ) : null}
        </g>
        <g className={styles.paper}>
          <rect x="40" y="96" width="40" height="30" rx="2" fill="#fff" stroke="#d9d4c7" />
          <path d="M45 103 h30 M45 109 h26 M45 115 h28" stroke="#c9c2b2" strokeWidth="2" />
        </g>
      </g>
      <g className={styles.head}>
        <circle cx="60" cy="44" r="21" fill={look.skin} />
        <path d={look.hairPath} fill={look.hair} />
        {seat !== 'S' ? <Extra look={look} /> : null}
        <g className={styles.eyes} fill="#1d1d1d">
          <ellipse cx="52.5" cy="45" rx="2" ry="2.4" /><ellipse cx="67.5" cy="45" rx="2" ry="2.4" />
        </g>
        <path className={styles.mouth} d="M55 54 Q60 58 65 54" fill="none" stroke="#7a3b2e" strokeWidth="2" strokeLinecap="round" />
        <circle cx="47" cy="52" r="3" fill="#f08a7a" opacity=".25" /><circle cx="73" cy="52" r="3" fill="#f08a7a" opacity=".25" />
      </g>
      <g className={styles.thought} fill="#fff" stroke="#d6d1c4">
        <circle cx="92" cy="22" r="3" /><circle cx="99" cy="13" r="4.5" /><circle cx="108" cy="4" r="3.5" />
      </g>
    </svg>
  );
}
