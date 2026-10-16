/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { MoveRight } from 'lucide-react';
import { VOICE_WALL, type VoiceNote } from '@/lib/landing/landing-copy';
import { J_NOTE_ANSWERS, J_NOTE_HEADS, J_VOICE, noteSource } from '@/lib/landing/landing-copy-j';
import { WallMoreJ } from './MotionJ';
import styles from './j.module.css';

const TILTS = ['-1.2deg', '.8deg', '-.5deg', '1.1deg'];
/** How many rows a phone shows before "看另外 N 条"; with `four` (sample K), every screen shows four. */
const WALL_FIRST = 3;
const WALL_FOUR = 4;
/** The Owner's order (2026-10-14): P7 ("AI 通常只是给你更多内容……") opens the wall. */
const FIRST = 'p7';

/**
 * Right after the first screen: the voice wall in sample F's form — each user's own words on a yellow note, an
 * arrow, and the coach's answer under a heading of its own that names the fix. Forum quotes carry the platform,
 * the user's full ID and the date (no links); report quotes keep the outlet, the interviewee and the date.
 */
/**
 * Sample L (Owner 2026-10-17): `open` shows every row on every screen, no fold; `regions` adds where each note is from
 * (by note id) to its caption.
 */
export function VoiceWallJ({ notes, four = false, open = false, regions }: {
  notes: readonly VoiceNote[]; four?: boolean; open?: boolean; regions?: Readonly<Record<string, string>>;
}) {
  if (notes.length === 0) return null;
  const ordered = [...notes.filter(note => note.id === FIRST), ...notes.filter(note => note.id !== FIRST)];
  return (
    <section aria-labelledby="voice-title" className={styles.section} data-zone="voice" data-band="tint" data-region="用户心声">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <h2 id="voice-title" className={styles.display}>{J_VOICE.title}</h2>
        </div>
        <ol id="j-voice-wall" className={styles.voiceRows} data-four={four || undefined}>
          {ordered.map((note, index) => (
            <li key={note.id} data-row="" className={styles.voiceRow} data-region="心声卡片">
              <figure className={styles.note} style={{ '--tilt': TILTS[index % TILTS.length] } as CSSProperties}>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>
                  {regions?.[note.id] ? `${regions[note.id]} · ` : ''}{noteSource(note.id, note.source)}
                  {note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}
                </figcaption>
              </figure>
              <MoveRight className={styles.arrow} size={28} aria-hidden="true" />
              <div className={styles.answer}>
                <p className={styles.answerHead}><i aria-hidden="true" />{J_NOTE_HEADS[note.id] ?? '教练怎么做'}</p>
                <p>{J_NOTE_ANSWERS[note.id] ?? note.answer}</p>
              </div>
            </li>
          ))}
        </ol>
        {!open && ordered.length > (four ? WALL_FOUR : WALL_FIRST)
          ? <WallMoreJ listId="j-voice-wall" hiddenCount={ordered.length - (four ? WALL_FOUR : WALL_FIRST)} always={four} /> : null}
      </div>
    </section>
  );
}
