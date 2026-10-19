/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { VOICE_WALL, type VoiceNote } from '@/lib/landing/landing-copy';
import { J_NOTE_ANSWERS, J_NOTE_HEADS, J_VOICE, noteSource } from '@/lib/landing/landing-copy-j';
import { L_NOTE_REGIONS } from '@/lib/landing/landing-copy-l';
import { StationO } from './RouteO';
import styles from './o.module.css';

/** The Owner's order (2026-10-14): P7 opens the wall (as in VoiceWallJ). */
const FIRST = 'p7';

/**
 * Region 2, station 1 "你现在在这": sample L's voice wall, every note unfolded with its region and source, each pinned
 * like a label on a map (a white card, the gold station mark on its left, a pin at its corner): the person's words
 * on top, the coach's answer under its own heading below. Two columns where they fit.
 */
export function VoiceO({ notes, station }: { notes: readonly VoiceNote[]; station: string }) {
  if (notes.length === 0) return null;
  const ordered = [...notes.filter(note => note.id === FIRST), ...notes.filter(note => note.id !== FIRST)];
  return (
    <section aria-labelledby="voice-title" className={styles.section} data-region="用户心声">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <StationO n={station} label="你现在在这" />
          <h2 id="voice-title" className={styles.title}>{J_VOICE.title}</h2>
        </div>
        <ol className={styles.voices}>
          {ordered.map(note => (
            <li key={note.id} data-row="" className={styles.voice} data-region="心声卡片">
              <figure>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>
                  {L_NOTE_REGIONS[note.id] ? `${L_NOTE_REGIONS[note.id]} · ` : ''}{noteSource(note.id, note.source)}
                  {note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}
                </figcaption>
              </figure>
              <div className={styles.voiceAnswer}>
                <p className={styles.voiceHead}>{J_NOTE_HEADS[note.id] ?? '教练怎么做'}</p>
                <p>{J_NOTE_ANSWERS[note.id] ?? note.answer}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
