/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { Quote, Sparkles } from 'lucide-react';
import { VOICE_WALL, type VoiceNote } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { RevealOnScroll } from './RevealOnScroll';
import styles from './offer.module.css';

const TILTS = ['-1.2deg', '0.8deg', '-0.6deg', '1.1deg'];

/**
 * Sticky-note wall (offer brief section 13): the complaint in the visitor's own words on the left,
 * how the coach handles it on the right. On phones the two stack. Quotes are verbatim with platform
 * and date, no user names and no links.
 */
export function VoiceWall({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="voice-wall-title" className={cn(styles.deferred, 'border-t border-[#1F1F1F] px-4 py-20 sm:px-6 md:py-28 lg:px-8')}>
      <div className="mx-auto max-w-5xl">
        <h2 id="voice-wall-title" className="text-center text-3xl font-bold text-white md:text-4xl">{VOICE_WALL.title}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-base text-[#9A9A9A]">{VOICE_WALL.lede}</p>
        <RevealOnScroll className="mt-12 grid gap-8 md:gap-10">
          {notes.map((note, index) => (
            <div key={note.id} data-reveal-row="" className={cn(styles.revealRow, 'grid items-center gap-4 md:grid-cols-2 md:gap-8')}>
              <figure
                className={cn(styles.note, 'relative rounded-sm bg-[#FFF3B0] p-5 text-[#2B2400] shadow-[0_10px_24px_rgba(0,0,0,0.35)]')}
                style={{ '--note-tilt': TILTS[index % TILTS.length] } as CSSProperties}
              >
                <Quote className="mb-2 h-5 w-5 text-[#B08900]" aria-hidden="true" />
                <blockquote className="text-base leading-relaxed">「{note.quote}」</blockquote>
                <figcaption className="mt-3 text-xs text-[#6B5A00]">
                  {note.source}
                  {note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}
                </figcaption>
              </figure>
              <div className={cn(styles.revealAnswer, 'rounded-2xl border border-[#FFD700]/30 bg-[#141414] p-5')}>
                <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#FFD700]">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  教练怎么做
                </p>
                <p className="text-base leading-relaxed text-[#E5E5E5]">{note.answer}</p>
              </div>
            </div>
          ))}
        </RevealOnScroll>
      </div>
    </section>
  );
}
