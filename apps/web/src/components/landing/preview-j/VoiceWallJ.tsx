/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { MoveRight } from 'lucide-react';
import { VOICE_WALL, type VoiceNote } from '@/lib/landing/landing-copy';
import { J_NOTE_HEADS, J_VOICE, noteSource } from '@/lib/landing/landing-copy-j';
import { WallMoreJ } from './MotionJ';
import styles from './j.module.css';

const TILTS = ['-1.2deg', '.8deg', '-.5deg', '1.1deg'];
/** How many rows a phone shows before "看另外 N 条". */
const WALL_FIRST = 3;
/** The Owner's order (2026-10-14): P7 ("AI 通常只是给你更多内容……") opens the wall. */
const FIRST = 'p7';

/**
 * Right after the first screen: the voice wall in sample F's form — each user's own words on a yellow note, an
 * arrow, and the coach's answer under a heading of its own that names the fix. Forum quotes carry the platform,
 * the user's full ID and the date (no links); report quotes keep the outlet, the interviewee and the date.
 */
export function VoiceWallJ({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  const ordered = [...notes.filter(note => note.id === FIRST), ...notes.filter(note => note.id !== FIRST)];
  return (
    <section aria-labelledby="voice-title" className={styles.section}>
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <h2 id="voice-title" className={styles.display}>{J_VOICE.title}</h2>
        </div>
        <ol id="j-voice-wall" className={styles.voiceRows}>
          {ordered.map((note, index) => (
            <li key={note.id} data-row="" className={styles.voiceRow}>
              <figure className={styles.note} style={{ '--tilt': TILTS[index % TILTS.length] } as CSSProperties}>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>{noteSource(note.id, note.source)}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
              </figure>
              <MoveRight className={styles.arrow} size={28} aria-hidden="true" />
              <div className={styles.answer}>
                <p className={styles.answerHead}><i aria-hidden="true" />{J_NOTE_HEADS[note.id] ?? '教练怎么做'}</p>
                <p>{note.answer}</p>
              </div>
            </li>
          ))}
        </ol>
        {ordered.length > WALL_FIRST ? <WallMoreJ listId="j-voice-wall" hiddenCount={ordered.length - WALL_FIRST} /> : null}
      </div>
    </section>
  );
}
