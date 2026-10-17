/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { VOICE_WALL, type VoiceNote } from '@/lib/landing/landing-copy';
import { J_NOTE_ANSWERS, J_NOTE_HEADS, J_VOICE, noteSource } from '@/lib/landing/landing-copy-j';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

/** The Owner's order (2026-10-14): P7 ("AI 通常只是给你更多内容……") opens the wall; the frame rests on it. */
const FIRST = 'p7';

/**
 * Region 2 as a staggered wall of message cells (direction E): every voice of sample L, unfolded, each cell holding
 * the person's own words, where they are from and the source, then the coach's answer under its own heading. The
 * cells fall into columns of their own height (one on a phone, two on a tablet, three on a computer). The first
 * note is the key cell and is set larger.
 */
export function VoiceN({ notes, regions }: { notes: readonly VoiceNote[]; regions: Readonly<Record<string, string>> }) {
  if (notes.length === 0) return null;
  const ordered = [...notes.filter(note => note.id === FIRST), ...notes.filter(note => note.id !== FIRST)];
  return (
    <section aria-labelledby="voice-title" className={styles.section} data-zone="voice" data-region="用户心声">
      <div className={styles.wrap}>
        <div className={styles.head}><h2 id="voice-title" className={styles.h2}>{J_VOICE.title}</h2></div>
        <ol className={styles.wall}>
          {ordered.map((note, index) => (
            <li key={note.id} className={cn(styles.cell, styles.noteCell)} data-cell="" data-region="心声卡片"
              data-key={index === 0 ? '' : undefined} data-first={index === 0 || undefined}>
              <figure>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>
                  {regions[note.id] ? `${regions[note.id]} · ` : ''}{noteSource(note.id, note.source)}
                  {note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}
                </figcaption>
              </figure>
              <div className={styles.noteAnswer}>
                <p className={styles.noteHead}>{J_NOTE_HEADS[note.id] ?? '教练怎么做'}</p>
                <p>{J_NOTE_ANSWERS[note.id] ?? note.answer}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
