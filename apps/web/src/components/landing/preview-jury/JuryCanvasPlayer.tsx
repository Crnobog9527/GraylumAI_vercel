/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo } from 'react';
import { DEFAULT_SEAT_NAMES, type JurySeatNames, type SeatCode } from './jury-events';
import { briefScenes } from './jury-brief';
import { canvasAt } from './jury-canvas';
import { mockCase, type JuryCase } from './jury-case';
import { buildScenes, playbackLength } from './jury-scenes';
import { JuryCanvas } from './JuryCanvas';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import theme from './jury-theme.module.css';

export type JuryCanvasPlayerProps = {
  /** The case to play (reports and events, see jury-case.ts); the prototype's mock creator by default. Keep it stable
   * (a module constant or useMemo): the playback plan is rebuilt when it changes. */
  data?: JuryCase;
  /** 0→1: freeze the canvas at that point of the review, e.g. driven by the page's scrolling. Unset: it plays by itself. */
  progress?: number;
  /** Playback speed when it plays by itself; read once, when mounted. 1 is reading pace. */
  speed?: number;
  /** Short version: only the key moments (seated, reading, disagreement, summary, new report). */
  brief?: boolean;
  names?: JurySeatNames;
  /** A person or card was clicked. Without it the people and cards are not clickable. */
  onPick?: (seat: SeatCode) => void;
};

/**
 * The canvas on its own, for embedding (the landing page): no toolbar, records or result page. It either plays by
 * itself once, or follows `progress`. With reduced motion and no `progress` it shows the last frame. On a computer
 * the canvas fills its parent's height, so give the parent one.
 */
export function JuryCanvasPlayer({ data, progress, speed = 1, brief = false, names = DEFAULT_SEAT_NAMES, onPick }: JuryCanvasPlayerProps) {
  const reduced = usePrefersReducedMotion();
  const juryCase = data ?? mockCase('full');
  const scenes = useMemo(() => {
    const full = buildScenes(juryCase.arrivals);
    return brief ? briefScenes(full) : full;
  }, [juryCase.arrivals, brief]);
  const length = playbackLength(scenes);
  const driven = progress !== undefined;
  const playback = useJuryPlayback(length, !reduced && !driven, speed);
  const last = Math.max(0, length - 1);
  const clock = driven ? Math.min(1, Math.max(0, progress)) * last : reduced ? last : Math.min(playback.clock, last);
  return (
    <div className={theme.player}>
      <JuryCanvas view={canvasAt(scenes, clock, names)} names={names} selected={null} report={juryCase.report} follow={!driven}
        onPeek={() => {}} onPick={onPick} />
    </div>
  );
}
